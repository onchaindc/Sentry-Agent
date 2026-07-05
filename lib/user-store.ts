import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultPolicy, type Policy } from "./policy";
import type { ActivityItem } from "./casper";

const STORE_PATH =
  process.env.SENTRY_AGENT_STORE_PATH ??
  (process.env.VERCEL ? join("/tmp", "sentry-agent-store.json") : join(process.cwd(), ".data", "sentry-agent-store.json"));

export type AgentRecord = {
  publicKey: string;
  accountHash: string;
  privateKeyPem: string;
  algorithm: "secp256k1";
};

export type UserRecord = {
  userPublicKey: string;
  agent: AgentRecord;
  policy: Policy;
  activity: ActivityItem[];
  createdAt: number;
  updatedAt: number;
};

type StoreShape = {
  users: Record<string, UserRecord>;
};

type CreateAgentForUser = (userPublicKey: string) => Promise<AgentRecord>;

function normalizePublicKey(value: string) {
  return value.trim();
}

async function ensureStoreFile() {
  await mkdir(dirname(STORE_PATH), { recursive: true });

  try {
    await readFile(STORE_PATH, "utf8");
  } catch {
    const initial: StoreShape = { users: {} };
    await writeFile(STORE_PATH, JSON.stringify(initial, null, 2), "utf8");
  }
}

async function readStore() {
  await ensureStoreFile();
  const raw = await readFile(STORE_PATH, "utf8");
  return JSON.parse(raw) as StoreShape;
}

async function writeStore(store: StoreShape) {
  await ensureStoreFile();
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

async function createDefaultRecord(
  store: StoreShape,
  normalizedKey: string,
  createAgent: CreateAgentForUser,
) {
  const now = Date.now();
  const nextRecord: UserRecord = {
    userPublicKey: normalizedKey,
    agent: await createAgent(normalizedKey),
    policy: defaultPolicy,
    activity: [],
    createdAt: now,
    updatedAt: now,
  };

  store.users[normalizedKey] = nextRecord;

  return nextRecord;
}

export async function getUserRecord(userPublicKey: string, createAgent?: CreateAgentForUser) {
  const normalizedKey = normalizePublicKey(userPublicKey);
  const store = await readStore();
  const existing = store.users[normalizedKey];

  if (existing) {
    return existing;
  }

  if (!createAgent) {
    return null;
  }

  const nextRecord = await createDefaultRecord(store, normalizedKey, createAgent);
  await writeStore(store);
  return nextRecord;
}

export async function ensureUserRecord(
  userPublicKey: string,
  createAgent: CreateAgentForUser,
) {
  const record = await getUserRecord(userPublicKey, createAgent);
  if (!record) {
    throw new Error("User session not found.");
  }

  return record;
}

export async function updateUserPolicy(
  userPublicKey: string,
  policy: Policy,
  createAgent?: CreateAgentForUser,
) {
  const normalizedKey = normalizePublicKey(userPublicKey);
  const store = await readStore();
  const record = store.users[normalizedKey] ?? (createAgent ? await createDefaultRecord(store, normalizedKey, createAgent) : null);

  if (!record) {
    throw new Error("User session not found.");
  }

  const nextRecord: UserRecord = {
    ...record,
    policy,
    updatedAt: Date.now(),
  };

  store.users[normalizedKey] = nextRecord;
  await writeStore(store);

  return nextRecord;
}

export async function updateUserActivity(
  userPublicKey: string,
  activity: ActivityItem[],
  createAgent?: CreateAgentForUser,
) {
  const normalizedKey = normalizePublicKey(userPublicKey);
  const store = await readStore();
  const record = store.users[normalizedKey] ?? (createAgent ? await createDefaultRecord(store, normalizedKey, createAgent) : null);

  if (!record) {
    throw new Error("User session not found.");
  }

  const nextRecord: UserRecord = {
    ...record,
    activity: activity.slice(0, 50),
    updatedAt: Date.now(),
  };

  store.users[normalizedKey] = nextRecord;
  await writeStore(store);

  return nextRecord;
}
