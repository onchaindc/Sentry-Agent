import { createRequire } from "node:module";

const CSPR_TRADE_MCP_URL = process.env.CSPR_TRADE_MCP_URL ?? "https://mcp.cspr.trade/mcp";
const TESTNET_CHAIN_ID = "casper:casper-test";
const WCSPR_PACKAGE_HASH = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
const require = createRequire(import.meta.url);
const { PrivateKey, KeyAlgorithm } = require("casper-js-sdk") as typeof import("casper-js-sdk");

type JsonRecord = Record<string, unknown>;

type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

type McpToolCall = {
  tool: string;
  arguments: Record<string, unknown>;
  responseSummary: string;
};

export type McpBalanceReadResult = {
  connected: boolean;
  nativeCspr: number | null;
  wcsprRawBalance: string | null;
  trace: string[];
  toolCalls: McpToolCall[];
  fallbackReason?: string;
};

function summarizeValue(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return "";
  }

  return text.length > 320 ? `${text.slice(0, 320)}...` : text;
}

function normalizeToolResponse(result: unknown) {
  if (!result || typeof result !== "object") {
    return {
      summary: summarizeValue(result),
      raw: result,
    };
  }

  const candidate = result as {
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };

  if (candidate.structuredContent) {
    return {
      summary: summarizeValue(candidate.structuredContent),
      raw: candidate.structuredContent,
    };
  }

  const textContent = candidate.content
    ?.filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");

  if (textContent) {
    try {
      return {
        summary: summarizeValue(textContent),
        raw: JSON.parse(textContent),
      };
    } catch {
      return {
        summary: summarizeValue(textContent),
        raw: textContent,
      };
    }
  }

  return {
    summary: summarizeValue(result),
    raw: result,
  };
}

function findToolByName(tools: McpToolDefinition[], names: string[]) {
  return tools.find((tool) => names.includes(tool.name));
}

function getSchemaPropertyNames(tool: McpToolDefinition) {
  return Object.keys(tool.inputSchema?.properties ?? {});
}

function findPropertyName(properties: string[], candidates: string[]) {
  const lowered = properties.map((property) => ({
    original: property,
    lowered: property.toLowerCase(),
  }));

  for (const candidate of candidates) {
    const match = lowered.find((property) => property.lowered === candidate.toLowerCase());
    if (match) {
      return match.original;
    }
  }

  for (const candidate of candidates) {
    const match = lowered.find((property) => property.lowered.includes(candidate.toLowerCase()));
    if (match) {
      return match.original;
    }
  }

  return null;
}

function setIfPresent(
  target: Record<string, unknown>,
  properties: string[],
  candidates: string[],
  value: unknown,
) {
  const propertyName = findPropertyName(properties, candidates);
  if (propertyName) {
    target[propertyName] = value;
  }
}

function parseNumericBalance(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value as JsonRecord)) {
    if (/(cspr|balance|amount)/i.test(key)) {
      const parsed = parseNumericBalance(nestedValue);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return null;
}

function parseRawTokenBalance(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value as JsonRecord)) {
    if (/(balance|amount|token)/i.test(key)) {
      const parsed = parseRawTokenBalance(nestedValue);
      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

function toMcpPublicKey(publicKeyHex: string) {
  const normalized = publicKeyHex.trim().replace(/^0x/i, "");

  // Casper SDK public keys include a leading algorithm tag byte.
  // CSPR.trade MCP expects the compressed secp256k1 public key itself.
  if (normalized.length === 68 && normalized.startsWith("02")) {
    return normalized.slice(2);
  }

  return normalized;
}

function buildPublicKeyCandidates(publicKeyHex: string, accountHash?: string) {
  const normalized = publicKeyHex.trim().replace(/^0x/i, "");
  const compressed = toMcpPublicKey(normalized);
  const accountHashHex = accountHash?.replace(/^account-hash-/i, "").trim();

  return Array.from(
    new Set(
      [
        compressed,
        normalized,
        `0x${compressed}`,
        `0x${normalized}`,
        accountHashHex,
        accountHashHex ? `account-hash-${accountHashHex}` : null,
        accountHashHex ? `0x${accountHashHex}` : null,
      ].filter((value): value is string => Boolean(value)),
    ),
  );
}

function responseLooksLikeError(summary: string) {
  return /^error:/i.test(summary.trim());
}

async function openClient() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );

  const client = new Client({
    name: "SentryAgent",
    version: "0.1.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(CSPR_TRADE_MCP_URL));
  await client.connect(transport);

  return { client, transport };
}

export async function readAgentBalancesViaCsprTradeMcp(
  publicKey: string,
  accountHash?: string,
  privateKeyPem?: string,
): Promise<McpBalanceReadResult> {
  const canonicalCasperPublicKey = privateKeyPem?.trim()
    ? PrivateKey.fromPem(privateKeyPem, KeyAlgorithm.SECP256K1).publicKey.toHex()
    : publicKey;
  const canonicalPublicKey = toMcpPublicKey(canonicalCasperPublicKey);
  const publicKeyCandidates = buildPublicKeyCandidates(canonicalCasperPublicKey, accountHash);
  const trace: string[] = [
    `1. Connecting to CSPR.trade MCP at ${CSPR_TRADE_MCP_URL}.`,
    `Canonical MCP public key: ${canonicalPublicKey}.`,
    `Public key candidates: ${publicKeyCandidates.join(", ")}.`,
  ];
  const toolCalls: McpToolCall[] = [];

  let clientHandle:
    | {
        client: {
          listTools: () => Promise<{ tools?: McpToolDefinition[] }>;
          callTool: (input: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
          close?: () => Promise<void> | void;
        };
        transport?: {
          close?: () => Promise<void> | void;
        };
      }
    | undefined;

  try {
    clientHandle = await openClient();
    trace.push("2. MCP transport connected successfully.");

    const toolList = await clientHandle.client.listTools();
    const tools = toolList.tools ?? [];
    trace.push(`3. Server advertised ${tools.length} tools.`);

    const nativeTool = findToolByName(tools, ["get_native_cspr_balance"]);
    if (!nativeTool) {
      throw new Error("CSPR.trade MCP did not advertise get_native_cspr_balance.");
    }

    const nativeProperties = getSchemaPropertyNames(nativeTool);
    trace.push(`Native balance tool schema keys: ${nativeProperties.join(", ") || "none"}.`);
    let normalizedNative: { summary: string; raw: unknown } = {
      summary: "Error: No MCP public key candidate succeeded.",
      raw: null,
    };

    trace.push(`4. Calling ${nativeTool.name} via MCP.`);
    for (const candidate of publicKeyCandidates) {
      const nativeArgs: Record<string, unknown> = {};
      setIfPresent(nativeArgs, nativeProperties, ["account_public_key"], candidate);
      setIfPresent(nativeArgs, nativeProperties, ["public_key", "publicKey"], candidate);
      setIfPresent(
        nativeArgs,
        nativeProperties,
        ["account_hash", "accountHash", "address", "account", "owner"],
        candidate,
      );
      setIfPresent(nativeArgs, nativeProperties, ["network", "chain", "chain_id"], TESTNET_CHAIN_ID);

      const nativeResult = await clientHandle.client.callTool({
        name: nativeTool.name,
        arguments: nativeArgs,
      });
      normalizedNative = normalizeToolResponse(nativeResult);
      toolCalls.push({
        tool: nativeTool.name,
        arguments: nativeArgs,
        responseSummary: normalizedNative.summary,
      });
      trace.push(`5. ${nativeTool.name} candidate ${candidate} -> ${normalizedNative.summary}`);

      if (!responseLooksLikeError(normalizedNative.summary)) {
        break;
      }
    }

    const tokenTool = findToolByName(tools, ["get_token_balance"]);
    let wcsprRawBalance: string | null = null;

    if (tokenTool) {
      const tokenProperties = getSchemaPropertyNames(tokenTool);
      trace.push(`Token balance tool schema keys: ${tokenProperties.join(", ") || "none"}.`);
      trace.push(`6. Calling ${tokenTool.name} for WCSPR via MCP.`);
      for (const candidate of publicKeyCandidates) {
        const tokenArgs: Record<string, unknown> = {};
        setIfPresent(tokenArgs, tokenProperties, ["account_public_key"], candidate);
        setIfPresent(tokenArgs, tokenProperties, ["public_key", "publicKey"], candidate);
        setIfPresent(
          tokenArgs,
          tokenProperties,
          ["account_hash", "accountHash", "address", "owner", "account"],
          candidate,
        );
        setIfPresent(
          tokenArgs,
          tokenProperties,
          ["token", "token_address", "tokenAddress", "contract_hash", "contractHash", "package_hash", "packageHash", "asset"],
          WCSPR_PACKAGE_HASH,
        );
        setIfPresent(tokenArgs, tokenProperties, ["network", "chain", "chain_id"], TESTNET_CHAIN_ID);

        const tokenResult = await clientHandle.client.callTool({
          name: tokenTool.name,
          arguments: tokenArgs,
        });
        const normalizedToken = normalizeToolResponse(tokenResult);
        toolCalls.push({
          tool: tokenTool.name,
          arguments: tokenArgs,
          responseSummary: normalizedToken.summary,
        });
        trace.push(`7. ${tokenTool.name} candidate ${candidate} -> ${normalizedToken.summary}`);
        wcsprRawBalance = parseRawTokenBalance(normalizedToken.raw);

        if (!responseLooksLikeError(normalizedToken.summary)) {
          break;
        }
      }
    } else {
      trace.push("6. Server did not advertise get_token_balance; skipped WCSPR lookup.");
    }

    return {
      connected: true,
      nativeCspr: parseNumericBalance(normalizedNative.raw),
      wcsprRawBalance,
      trace,
      toolCalls,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown MCP connection failure.";
    trace.push(`MCP failure: ${message}`);
    return {
      connected: false,
      nativeCspr: null,
      wcsprRawBalance: null,
      trace,
      toolCalls,
      fallbackReason: message,
    };
  } finally {
    try {
      await clientHandle?.client.close?.();
    } catch {
      // ignore close failures from remote MCP transports
    }

    try {
      await clientHandle?.transport?.close?.();
    } catch {
      // ignore close failures from remote MCP transports
    }
  }
}
