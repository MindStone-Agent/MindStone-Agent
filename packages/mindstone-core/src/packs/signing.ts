/**
 * ed25519 detached signatures over archive digests (design D4). Node's
 * crypto supports ed25519 natively; raw 32-byte keys travel as
 * "ed25519:<base64>" strings and are DER-wrapped for KeyObject import.
 * No dependencies, no external tooling.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

/** SPKI DER prefix for a raw ed25519 public key (RFC 8410). */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** PKCS8 DER prefix for a raw ed25519 private key seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function publicKeyFromString(encoded: string): KeyObject {
  const match = /^ed25519:([A-Za-z0-9+/=]+)$/.exec(encoded.trim());
  if (!match) throw new Error("public key must be of the form ed25519:<base64>");
  const raw = Buffer.from(match[1], "base64");
  if (raw.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

export function privateKeyFromString(encoded: string): KeyObject {
  const match = /^ed25519-priv:([A-Za-z0-9+/=]+)$/.exec(encoded.trim());
  if (!match) throw new Error("private key must be of the form ed25519-priv:<base64>");
  const raw = Buffer.from(match[1], "base64");
  if (raw.length !== 32) throw new Error(`ed25519 private key seed must be 32 bytes, got ${raw.length}`);
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]), format: "der", type: "pkcs8" });
}

/** Generate a dev keypair (pack build tooling / smoke fixtures — not production key management). */
export function generatePackKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return {
    publicKey: `ed25519:${spki.subarray(SPKI_ED25519_PREFIX.length).toString("base64")}`,
    privateKey: `ed25519-priv:${pkcs8.subarray(PKCS8_ED25519_PREFIX.length).toString("base64")}`,
  };
}

/**
 * Sign the sha256 digest of an archive. The signature is over the raw digest
 * bytes (not the hex string) — deterministic and matched by verifySignature.
 */
export function signArchiveDigest(digestHex: string, privateKeyEncoded: string): string {
  const signature = sign(null, Buffer.from(digestHex, "hex"), privateKeyFromString(privateKeyEncoded));
  return signature.toString("base64");
}

export function verifyArchiveDigest(digestHex: string, signatureBase64: string, publicKeyEncoded: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(digestHex, "hex"),
      publicKeyFromString(publicKeyEncoded),
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false; // malformed key/signature = verification failure, never a crash
  }
}
