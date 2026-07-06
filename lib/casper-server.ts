import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import type * as CasperSdk from "casper-js-sdk";
import type { AgentRecord } from "./user-store";

const require = createRequire(import.meta.url);
const {
  Args,
  CLValue,
  ContractHash,
  Deploy,
  DeployHeader,
  ExecutableDeployItem,
  HttpHandler,
  KeyAlgorithm,
  PrivateKey,
  PublicKey,
  PurseIdentifier,
  RpcClient,
  StoredContractByHash,
  makeCsprTransferDeploy,
} = require("casper-js-sdk") as typeof CasperSdk;

const CASPER_NODE_ADDRESS =
  process.env.CASPER_RPC_URL ??
  process.env.ODRA_CASPER_LIVENET_NODE_ADDRESS ??
  "https://node.testnet.cspr.cloud";
const CASPER_RPC_URL = CASPER_NODE_ADDRESS.endsWith("/rpc")
  ? CASPER_NODE_ADDRESS
  : `${CASPER_NODE_ADDRESS.replace(/\/$/, "")}/rpc`;
const CASPER_CHAIN_NAME = "casper-test";
const SPEND_GUARDRAIL_CONTRACT_HASH =
  "contract-808477e815f794497a8f18b62d6ec5b70cfdf4c20da4335c65d3562122c89fe8";
const CONTRACT_PAYMENT_AMOUNT = "100000000";
const TRANSFER_PAYMENT_AMOUNT = "100000000";
const EVENT_LENGTH_KEY = "__events_length";
const EVENTS_DICT_KEY = "__events";
const CSPR_MOTES = BigInt("1000000000");
const MAX_NATIVE_TRANSFER_JSON_BYTES = 20_000;
const AGENT_DERIVATION_SECRET =
  process.env.SENTRY_AGENT_SEED_SECRET ??
  process.env.CSPR_CLOUD_ACCESS_TOKEN ??
  "sentry-agent-demo-secret";

type RpcEnvelope<T> =
  | {
      result: T;
    }
  | {
      error: {
        message?: string;
        data?: string;
      };
    };

type ContractNamedKey = {
  name: string;
  key: string;
};

type DeployExecutionResult = {
  execution_result?: {
    Failure?: unknown;
    Success?: unknown;
  };
  result?: {
    Failure?: unknown;
    Success?: unknown;
  };
  Version2?: {
    error_message?: string | null;
  };
  error_message?: string | null;
};

export type RealCasperCheckResult = {
  status: "approved" | "blocked";
  deployHash: string;
  eventName?: string;
  onchainAmount: string;
  agentBalanceCspr?: number;
};

function stripContractPrefix(contractHash: string) {
  return contractHash.replace(/^contract-/, "");
}

function dollarsToCents(amount: number) {
  return String(Math.round(amount * 100));
}

function centsToWholeAmountString(value: string) {
  return value.replace(/^0+(?=\d)/, "");
}

function normalizeCsprAmount(value: string | number) {
  const raw = String(value).trim();

  if (!raw || !/^\d+(\.\d{1,9})?$/.test(raw)) {
    throw new Error("Amount must be a positive CSPR value with up to 9 decimals.");
  }

  return raw;
}

function csprToMotes(value: string | number) {
  const normalized = normalizeCsprAmount(value);
  const [wholePart, fractionalPart = ""] = normalized.split(".");
  const whole = BigInt(wholePart || "0");
  const fractional = BigInt((fractionalPart + "000000000").slice(0, 9));
  return (whole * CSPR_MOTES + fractional).toString();
}

function motesToCspr(value: string) {
  const motes = BigInt(value);
  const whole = motes / CSPR_MOTES;
  const fraction = motes % CSPR_MOTES;

  if (fraction === BigInt(0)) {
    return Number(whole);
  }

  return Number(`${whole}.${fraction.toString().padStart(9, "0").replace(/0+$/, "")}`);
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function summarizeCasperPayload(value: unknown, rawJson: string) {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const sessionJson = JSON.stringify(record.session ?? record.payload ?? {});
  const approvals = Array.isArray(record.approvals) ? record.approvals : [];
  const firstApproval = approvals[0];

  return {
    byteSize: byteLength(rawJson),
    topLevelKeys: Object.keys(record),
    approvalCount: approvals.length,
    approvalSignatureChars:
      typeof firstApproval === "object" &&
      firstApproval !== null &&
      typeof (firstApproval as Record<string, unknown>).signature === "string"
        ? ((firstApproval as Record<string, string>).signature.length)
        : null,
    paymentKeys:
      typeof record.payment === "object" && record.payment !== null
        ? Object.keys(record.payment as Record<string, unknown>)
        : null,
    sessionKeys:
      typeof record.session === "object" && record.session !== null
        ? Object.keys(record.session as Record<string, unknown>)
        : null,
    hasModuleBytes: sessionJson.includes("ModuleBytes") || sessionJson.includes("module_bytes"),
  };
}

async function rpcRequest<T>(method: string, params?: Record<string, unknown>) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(CASPER_RPC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method,
          params,
        }),
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Casper RPC ${method} failed with HTTP ${response.status}.`);
      }

      const payload = (await response.json()) as RpcEnvelope<T>;
      if ("error" in payload) {
        throw new Error(payload.error.data ?? payload.error.message ?? `Casper RPC ${method} failed.`);
      }

      return payload.result;
    } catch (error) {
      lastError = error;

      if (attempt === 3) {
        break;
      }

      await wait(1500 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Casper RPC ${method} failed.`);
}

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClient() {
  return new RpcClient(new HttpHandler(CASPER_RPC_URL));
}

function loadPrivateKey(pem: string) {
  return PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
}

async function getLatestStateRootHash() {
  const payload = await rpcRequest<{
    block_with_signatures?: {
      block?: {
        Version2?: {
          header?: {
            state_root_hash?: string;
          };
        };
      };
    };
  }>("chain_get_block");

  const stateRootHash = payload.block_with_signatures?.block?.Version2?.header?.state_root_hash;
  if (!stateRootHash) {
    throw new Error("Unable to read the latest Casper state root hash.");
  }

  return stateRootHash;
}

async function getContractNamedKeys() {
  const payload = await rpcRequest<{
    stored_value?: {
      Contract?: {
        named_keys?: ContractNamedKey[];
      };
    };
  }>("query_global_state", {
    state_identifier: null,
    key: `hash-${stripContractPrefix(SPEND_GUARDRAIL_CONTRACT_HASH)}`,
    path: [],
  });

  return payload.stored_value?.Contract?.named_keys ?? [];
}

async function queryUrefValue(uref: string) {
  const payload = await rpcRequest<{
    stored_value?: {
      CLValue?: {
        parsed?: number | string;
      };
    };
  }>("query_global_state", {
    state_identifier: null,
    key: uref,
    path: [],
  });

  return payload.stored_value?.CLValue;
}

async function readEventDictionaryItem(seedUref: string, dictionaryKey: string) {
  const stateRootHash = await getLatestStateRootHash();
  const payload = await rpcRequest<{
    stored_value?: {
      CLValue?: {
        bytes?: string;
      };
    };
  }>("state_get_dictionary_item", {
    state_root_hash: stateRootHash,
    dictionary_identifier: {
      URef: {
        seed_uref: seedUref,
        dictionary_item_key: dictionaryKey,
      },
    },
  });

  return payload.stored_value?.CLValue?.bytes ?? "";
}

function decodeEventName(bytesHex: string) {
  if (!bytesHex) {
    return undefined;
  }

  const ascii = Buffer.from(bytesHex, "hex").toString("utf8");
  const match = ascii.match(/event_[A-Za-z0-9_]+/);
  return match?.[0];
}

async function getEventState() {
  const namedKeys = await getContractNamedKeys();
  const lengthUref = namedKeys.find((item) => item.name === EVENT_LENGTH_KEY)?.key;
  const eventsDictUref = namedKeys.find((item) => item.name === EVENTS_DICT_KEY)?.key;

  if (!lengthUref || !eventsDictUref) {
    throw new Error("SpendGuardrail event keys are missing from contract state.");
  }

  const lengthValue = await queryUrefValue(lengthUref);
  const length = Number(lengthValue?.parsed ?? 0);

  return {
    length,
    eventsDictUref,
  };
}

function extractExecutionFailure(result: DeployExecutionResult | undefined) {
  if (!result) {
    return false;
  }

  if (result.error_message || result.Version2?.error_message) {
    return true;
  }

  return Boolean(result.execution_result?.Failure ?? result.result?.Failure);
}

async function waitForDeployResult(deployHash: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const payload = await rpcRequest<{
        executionResults?: DeployExecutionResult[];
        execution_results?: DeployExecutionResult[];
        execution_info?: DeployExecutionResult;
      }>("info_get_deploy", {
        deploy_hash: deployHash,
      });

      const executionResult =
        payload.executionResults?.[0] ?? payload.execution_results?.[0] ?? payload.execution_info;

      if (executionResult) {
        return executionResult;
      }
    } catch (error) {
      if (attempt === 29) {
        throw error;
      }
    }

    await wait(4000);
  }

  throw new Error(`Timed out waiting for Casper deploy ${deployHash}.`);
}

export async function createAgentWallet(): Promise<AgentRecord> {
  const privateKey = PrivateKey.generate(KeyAlgorithm.SECP256K1);
  const publicKey = privateKey.publicKey;

  return {
    publicKey: publicKey.toHex(),
    accountHash: publicKey.accountHash().toPrefixedString(),
    privateKeyPem: privateKey.toPem(),
    algorithm: "secp256k1",
  };
}

function deriveAgentPrivateKey(userPublicKey: string) {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const seedHex = createHmac("sha256", AGENT_DERIVATION_SECRET)
      .update(`sentry-agent:${userPublicKey}:${attempt}`)
      .digest("hex");

    try {
      return PrivateKey.fromHex(seedHex, KeyAlgorithm.SECP256K1);
    } catch {
      // try another counter if the candidate lands outside the curve range
    }
  }

  throw new Error("Failed to derive a deterministic agent private key.");
}

export async function createDeterministicAgentWallet(userPublicKey: string): Promise<AgentRecord> {
  const privateKey = deriveAgentPrivateKey(userPublicKey);
  const publicKey = privateKey.publicKey;

  return {
    publicKey: publicKey.toHex(),
    accountHash: publicKey.accountHash().toPrefixedString(),
    privateKeyPem: privateKey.toPem(),
    algorithm: "secp256k1",
  };
}

export async function getPublicKeyBalance(publicKeyHex: string) {
  const client = getClient();
  const balance = await client.queryLatestBalance(PurseIdentifier.fromPublicKey(PublicKey.fromHex(publicKeyHex)));
  return motesToCspr(balance.balance.toString());
}

export async function buildFundingTransferDeploy(userPublicKeyHex: string, agentPublicKeyHex: string, amountCspr: string) {
  const deploy = makeCsprTransferDeploy({
    senderPublicKeyHex: userPublicKeyHex,
    recipientPublicKeyHex: agentPublicKeyHex,
    transferAmount: csprToMotes(amountCspr),
    paymentAmount: TRANSFER_PAYMENT_AMOUNT,
    chainName: CASPER_CHAIN_NAME,
  });

  return Deploy.toJSON(deploy);
}

export async function submitSignedTransferDeploy(signedDeployJson: string) {
  const signedPayloadByteSize = byteLength(signedDeployJson);

  if (signedPayloadByteSize > MAX_NATIVE_TRANSFER_JSON_BYTES) {
    throw new Error(
      `Signed funding payload is ${signedPayloadByteSize} bytes before RPC submission. A native CSPR transfer should be compact.`,
    );
  }

  const parsed = JSON.parse(signedDeployJson);

  console.info("[funding.submit] signed-payload-shape", summarizeCasperPayload(parsed, signedDeployJson));

  let deploy: InstanceType<typeof Deploy>;
  try {
    deploy = Deploy.fromJSON(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deploy parse failed.";
    throw new Error(`Signed funding deploy is invalid before submission: ${message}`);
  }

  const compactDeployJson = Deploy.toJSON(deploy);
  const rpcBody = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "account_put_deploy",
    params: {
      deploy: compactDeployJson,
    },
  });
  const rpcBodyByteSize = byteLength(rpcBody);

  console.info("[funding.submit] account-put-deploy-rpc-body", {
    rpcUrl: CASPER_RPC_URL,
    byteSize: rpcBodyByteSize,
  });

  if (rpcBodyByteSize > MAX_NATIVE_TRANSFER_JSON_BYTES) {
    throw new Error(
      `Funding deploy RPC body is ${rpcBodyByteSize} bytes before submission. A native CSPR transfer should be compact.`,
    );
  }

  const putResult = await rpcRequest<{
    deploy_hash?: string;
  }>("account_put_deploy", {
    deploy: compactDeployJson,
  });
  const deployHash = putResult.deploy_hash;

  if (!deployHash) {
    throw new Error("Casper RPC did not return a deploy hash for the funding transfer.");
  }

  await waitForDeployResult(deployHash);

  return {
    deployHash,
  };
}

export async function confirmTransferDeploy(deployHash: string) {
  await waitForDeployResult(deployHash);

  return {
    deployHash,
  };
}

export async function runRealCasperCheckAndRecordForAgent(
  amount: number,
  agentPrivateKeyPem: string,
): Promise<RealCasperCheckResult> {
  const signer = loadPrivateKey(agentPrivateKeyPem);
  const beforeEvents = await getEventState();

  const deployHeader = DeployHeader.default();
  deployHeader.account = signer.publicKey;
  deployHeader.chainName = CASPER_CHAIN_NAME;

  const session = new ExecutableDeployItem();
  session.storedContractByHash = new StoredContractByHash(
    ContractHash.newContract(stripContractPrefix(SPEND_GUARDRAIL_CONTRACT_HASH)),
    "check_and_record",
    Args.fromMap({
      amount: CLValue.newCLUInt512(centsToWholeAmountString(dollarsToCents(amount))),
    }),
  );

  const payment = ExecutableDeployItem.standardPayment(CONTRACT_PAYMENT_AMOUNT);
  const deploy = Deploy.makeDeploy(deployHeader, payment, session);
  deploy.sign(signer);

  const client = getClient();
  const putResult = await client.putDeploy(deploy);
  const deployHash = putResult.deployHash.toHex();
  const executionResult = await waitForDeployResult(deployHash);
  const blocked = extractExecutionFailure(executionResult);

  let eventName: string | undefined;
  const afterEvents = await getEventState();

  if (afterEvents.length > beforeEvents.length) {
    eventName = decodeEventName(
      await readEventDictionaryItem(afterEvents.eventsDictUref, String(afterEvents.length - 1)),
    );
  }

  return {
    status: blocked ? "blocked" : "approved",
    deployHash,
    eventName,
    onchainAmount: dollarsToCents(amount),
  };
}
