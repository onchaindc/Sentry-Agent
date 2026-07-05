import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type * as CasperSdk from "casper-js-sdk";

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
  RpcClient,
  StoredContractByHash,
} = require("casper-js-sdk") as typeof CasperSdk;

const CASPER_RPC_URL = "https://node.testnet.casper.network/rpc";
const CASPER_CHAIN_NAME = "casper-test";
const SPEND_GUARDRAIL_CONTRACT_HASH =
  "contract-808477e815f794497a8f18b62d6ec5b70cfdf4c20da4335c65d3562122c89fe8";
const STANDARD_PAYMENT_AMOUNT = "3000000000";
const EVENT_LENGTH_KEY = "__events_length";
const EVENTS_DICT_KEY = "__events";

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
};

function stripContractPrefix(contractHash: string) {
  return contractHash.replace(/^contract-/, "");
}

function dollarsToCents(amount: number) {
  return String(Math.round(amount * 100));
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
        bytes?: string;
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
    dictionary_key?: string;
    stored_value?: {
      CLValue?: {
        bytes?: string;
        parsed?: unknown;
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

  if (result.error_message) {
    return true;
  }

  if (result.Version2?.error_message) {
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

  throw new Error(`Timed out waiting for deploy ${deployHash} to execute.`);
}

async function loadSigningKey() {
  const secretKeyPath = process.env.ODRA_CASPER_LIVENET_SECRET_KEY_PATH;

  if (!secretKeyPath) {
    throw new Error("ODRA_CASPER_LIVENET_SECRET_KEY_PATH is not set.");
  }

  const pem = await readFile(secretKeyPath, "utf8");
  return PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
}

export async function runRealCasperCheckAndRecord(amount: number): Promise<RealCasperCheckResult> {
  const onchainAmount = dollarsToCents(amount);
  const signingKey = await loadSigningKey();
  const client = new RpcClient(new HttpHandler(CASPER_RPC_URL, "fetch"));
  const eventStateBefore = await getEventState();

  const deployHeader = DeployHeader.default();
  deployHeader.account = signingKey.publicKey;
  deployHeader.chainName = CASPER_CHAIN_NAME;
  deployHeader.gasPrice = 1;

  const session = new ExecutableDeployItem();
  session.storedContractByHash = new StoredContractByHash(
    ContractHash.newContract(stripContractPrefix(SPEND_GUARDRAIL_CONTRACT_HASH)),
    "check_and_record",
    Args.fromMap({
      amount: CLValue.newCLUInt512(onchainAmount),
    }),
  );

  const payment = ExecutableDeployItem.standardPayment(STANDARD_PAYMENT_AMOUNT);
  const deploy = Deploy.makeDeploy(deployHeader, payment, session);
  deploy.sign(signingKey);

  const putResult = await client.putDeploy(deploy);
  const deployHash =
    "deployHash" in putResult && putResult.deployHash ? putResult.deployHash.toHex() : undefined;

  if (!deployHash) {
    throw new Error("Casper RPC did not return a deploy hash.");
  }

  const executionResult = await waitForDeployResult(deployHash);
  if (extractExecutionFailure(executionResult)) {
    return {
      status: "blocked",
      deployHash,
      onchainAmount,
    };
  }

  let eventName: string | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const eventStateAfter = await getEventState();
    if (eventStateAfter.length > eventStateBefore.length) {
      const latestEventBytes = await readEventDictionaryItem(
        eventStateAfter.eventsDictUref,
        String(eventStateAfter.length - 1),
      );
      eventName = decodeEventName(latestEventBytes);
      break;
    }

    await wait(2000);
  }

  if (eventName === "event_BlockedSpend") {
    return {
      status: "blocked",
      deployHash,
      eventName,
      onchainAmount,
    };
  }

  return {
    status: "approved",
    deployHash,
    eventName,
    onchainAmount,
  };
}
