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

export async function getUserRecord(userPublicKey: string) {
  const store = await readStore();
  return store.users[normalizePublicKey(userPublicKey)] ?? null;
}

export async function ensureUserRecord(
  userPublicKey: string,
  createAgent: () => Promise<AgentRecord>,
) {
  const normalizedKey = normalizePublicKey(userPublicKey);
  const store = await readStore();
  const existing = store.users[normalizedKey];

  if (existing) {
    return existing;
  }

  const now = Date.now();
  const nextRecord: UserRecord = {
    userPublicKey: normalizedKey,
    agent: await createAgent(),
    policy: defaultPolicy,
    activity: [],
    createdAt: now,
    updatedAt: now,
  };

  store.users[normalizedKey] = nextRecord;
  await writeStore(store);

  return nextRecord;
}

export async function updateUserPolicy(userPublicKey: string, policy: Policy) {
  const normalizedKey = normalizePublicKey(userPublicKey);
  const store = await readStore();
  const record = store.users[normalizedKey];

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

export async function updateUserActivity(userPublicKey: string, activity: ActivityItem[]) {
  const normalizedKey = normalizePublicKey(userPublicKey);
  const store = await readStore();
  const record = store.users[normalizedKey];

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
