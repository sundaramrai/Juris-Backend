// src/services/encryptionService.js
const crypto = require("crypto");
const { encryption } = require('../config');

function encryptText(text) {
  // Ensure text is a string; if not, default to an empty string.
  if (typeof text !== 'string') {
    text = text ? text.toString() : "";
  }
  // Check if the encryption key is defined.
  if (!encryption.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY environment variable is not defined");
  }
  // Convert the ENCRYPTION_KEY from hex to a Buffer.
  const keyBuffer = Buffer.from(encryption.ENCRYPTION_KEY, 'hex');
  // Verify that the key is exactly 32 bytes (256 bits).
  if (keyBuffer.length !== 32) {
    throw new Error("Invalid ENCRYPTION_KEY length. It must be a 64-character hex string representing 32 bytes.");
  }
  // Generate a random IV.
  const iv = crypto.randomBytes(encryption.IV_LENGTH);
  const cipher = crypto.createCipheriv(encryption.algorithm, keyBuffer, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  // Return the encrypted string in the format IV:encrypted:authTag.
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
  const decipher = crypto.createDecipheriv(
    encryption.algorithm, 
    Buffer.from(encryption.ENCRYPTION_KEY, 'hex'), 
    iv
  );
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = {
  encryptText,
  decryptText
};