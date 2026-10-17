import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Vault encryption: AES-256-GCM, key supplied as 64 hex chars (32 bytes) via
 * the TC_VAULT_KEY environment variable. Output format (base64):
 * iv(12) || tag(16) || ciphertext.
 */

export function parseVaultKey(hex: string): Buffer {
  const cleaned = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleaned)) {
    throw new Error("TC_VAULT_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32");
  }
  return Buffer.from(cleaned, "hex");
}

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function open(sealed: string, key: Buffer): string {
  const raw = Buffer.from(sealed, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Hash for invite codes and OAuth tokens at rest: only hashes hit storage. */
export function sha256hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Opaque random secret with a recognizable prefix, e.g. tcr_ab12... */
export function randomSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

/** Human-typeable invite code: XXXX-XXXX from an unambiguous alphabet. */
export function randomInviteCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const pick = () => alphabet[randomBytes(1)[0]! % alphabet.length]!;
  const block = () => pick() + pick() + pick() + pick();
  return `${block()}-${block()}`;
}

/** Constant-time string comparison (via fixed-length hashes) for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
