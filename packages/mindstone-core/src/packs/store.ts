/**
 * Pack state on disk (design §8): lock file, trust store, receipts, staging.
 * State writes use the atomic temp-file + rename pattern (as ApprovalStore
 * does). Corrupt state files surface as errors for doctor to report — pack
 * state is a security record, never silently replaced.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { MindStoneConfig } from "../config/types.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import type { PackLock, PackReceipt, PackTrustStore, PublisherKey } from "./types.js";

export type PackPaths = {
  packsDir: string;
  lockPath: string;
  trustPath: string;
  stagingDir: string;
  installedDir: string;
};

export function packPathsFromConfig(config: MindStoneConfig | undefined, paths?: MindStoneRuntimePaths): PackPaths {
  const resolved = paths ?? runtimePathsFromEnv();
  const packsDir = resolve(config?.packs?.dir ?? join(resolved.dataDir, "packs"));
  return {
    packsDir,
    lockPath: join(packsDir, "packs.lock.json"),
    trustPath: join(packsDir, "trust", "publishers.json"),
    stagingDir: join(packsDir, "staging"),
    installedDir: join(packsDir, "installed"),
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

function readJson<T>(path: string, label: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (error) {
    throw new Error(`${label} is corrupt at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readPackLock(paths: PackPaths): PackLock {
  return readJson<PackLock>(paths.lockPath, "packs.lock.json") ?? { schemaVersion: 1, packs: [] };
}

export function writePackLock(paths: PackPaths, lock: PackLock): void {
  writeJsonAtomic(paths.lockPath, lock);
}

/**
/**
 * Harness-shipped publisher trust seed. The harness distribution channel is the
 * root of trust (design D4): these keys are compiled into the harness, so a
 * fresh install verifies first-party ("mindstone") signed packs out of the box
 * — no manual `packs trust-add` needed. Operators pin ADDITIONAL keys on disk
 * (`packs trust-add`), which MERGE with these at verification time; they never
 * replace them. A shipped key is rotated/revoked only through a harness update.
 * The matching PRIVATE key is held offline by the publisher and never appears
 * anywhere in this tree.
 */
export const SHIPPED_PUBLISHER_KEYS: PublisherKey[] = [
  { keyId: "mindstone-2026a", publisherId: "mindstone", publicKey: "ed25519:oSNR/I0GfZzkJh6xpkpFjHtJgwLnQ0VOol2OGQ4k27E=" },
];

/**
 * Trust store. An absent on-disk store is fine now — the shipped seed above
 * covers first-party packs; the on-disk store holds only operator-added keys.
 * Fail closed for any publisher with no shipped and no on-disk key.
 */
export function readTrustStore(paths: PackPaths): PackTrustStore {
  return readJson<PackTrustStore>(paths.trustPath, "trust/publishers.json") ?? { schemaVersion: 1, publishers: [] };
}

export function writeTrustStore(paths: PackPaths, store: PackTrustStore): void {
  writeJsonAtomic(paths.trustPath, store);
}

export function trustedKeysForPublisher(store: PackTrustStore, publisherId: string, now = new Date()): string[] {
  // Shipped seed + operator-added on-disk keys, deduped by public key.
  const all = [...SHIPPED_PUBLISHER_KEYS, ...store.publishers];
  const seen = new Set<string>();
  return all
    .filter((key) => key.publisherId === publisherId)
    .filter((key) => !key.revoked)
    .filter((key) => !key.expiresAt || Date.parse(key.expiresAt) > now.getTime())
    .map((key) => key.publicKey)
    .filter((publicKey) => (seen.has(publicKey) ? false : (seen.add(publicKey), true)));
}

export function receiptPath(paths: PackPaths, packId: string): string {
  // Pack ids contain "/" (publisher/name); flatten for the directory name.
  return join(paths.installedDir, packId.replace("/", "__"), "receipt.json");
}

export function installedPackDir(paths: PackPaths, packId: string): string {
  return join(paths.installedDir, packId.replace("/", "__"));
}

export function readReceipt(paths: PackPaths, packId: string): PackReceipt | undefined {
  return readJson<PackReceipt>(receiptPath(paths, packId), `receipt for ${packId}`);
}

export function writeReceipt(paths: PackPaths, receipt: PackReceipt): void {
  writeJsonAtomic(receiptPath(paths, receipt.packId), receipt);
}

export function listInstalledPackIds(paths: PackPaths): string[] {
  if (!existsSync(paths.installedDir)) return [];
  return readdirSync(paths.installedDir)
    .filter((name) => existsSync(join(paths.installedDir, name, "receipt.json")))
    .map((name) => name.replace("__", "/"))
    .sort();
}

/** Find which installed pack (if any) owns an artifact store path. */
export function findOwningPack(paths: PackPaths, storePath: string, excludePackId?: string): string | undefined {
  for (const packId of listInstalledPackIds(paths)) {
    if (packId === excludePackId) continue;
    const receipt = readReceipt(paths, packId);
    if (receipt?.files.some((file) => file.storePath === storePath)) return packId;
  }
  return undefined;
}

export function clearStaging(paths: PackPaths, packId: string): void {
  const staging = join(paths.stagingDir, packId.replace("/", "__"));
  rmSync(staging, { recursive: true, force: true });
}

/** Stale staging dirs are inert; doctor warns and any pack command may clean them. */
export function listStaleStaging(paths: PackPaths): string[] {
  if (!existsSync(paths.stagingDir)) return [];
  return readdirSync(paths.stagingDir).sort();
}
