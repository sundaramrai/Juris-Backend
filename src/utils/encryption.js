const crypto = require("node:crypto");

const algorithm = "aes-256-gcm";
const IV_LENGTH = 16;

function encryptText(text) {
  if (typeof text !== 'string') {
    text = text ? text.toString() : "";
  }
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY environment variable is not defined");
  }
  const keyBuffer = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error("Invalid ENCRYPTION_KEY length. It must be a 64-character hex string representing 32 bytes.");
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(algorithm, keyBuffer, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + encrypted + ':' + authTag;
}

function decryptText(encryptedText) {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted text format");
  }
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  const authTag = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv(algorithm, Buffer.from(process.env.ENCRYPTION_KEY, 'hex'), iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function hashUsername(username) {
  return crypto
    .createHmac("sha256", process.env.USERNAME_HASH_SALT)
    .update(username.toLowerCase().trim())
    .digest("hex");
}

module.exports = { encryptText, decryptText, hashUsername };