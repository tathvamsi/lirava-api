import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../../config.js";
function key() { const value = Buffer.from(config.tokenEncryptionKey, "base64"); if (value.length !== 32)
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key."); return value; }
export function encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64"); }
export function decrypt(value) { const raw = Buffer.from(value, "base64"); const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"); }
