const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;

function getKey() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY env var not set');
  // Derive a 32-byte key from the secret
  return crypto.scryptSync(secret, 'tradepilot-salt', KEY_LENGTH);
}

/**
 * Encrypts a plaintext string
 * Returns: iv:authTag:encrypted (all hex encoded)
 */
function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an encrypted string
 * Input: iv:authTag:encrypted
 */
function decrypt(encryptedStr) {
  if (!encryptedStr) return null;
  try {
    const key = getKey();
    const [ivHex, authTagHex, encrypted] = encryptedStr.split(':');
    const iv      = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption failed:', err.message);
    return null;
  }
}

/**
 * Generate a secure license key
 * Format: XXXX-XXXX-XXXX-XXXX (uppercase alphanumeric)
 */
function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable chars
  const segment = () => Array.from({ length: 4 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
  return `${segment()}-${segment()}-${segment()}-${segment()}`;
}

/**
 * Generate a secure random token (for password reset etc)
 */
function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Mask a sensitive string for display
 * e.g. "sk_test_abc123" → "sk_test_***123"
 */
function maskKey(key, showLast = 4) {
  if (!key || key.length <= showLast) return '***';
  return key.slice(0, 6) + '***' + key.slice(-showLast);
}

module.exports = { encrypt, decrypt, generateLicenseKey, generateToken, maskKey };
