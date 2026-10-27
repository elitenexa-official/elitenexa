'use strict';
// RFC 6238 TOTP (SHA1, 6 digits, 30 s) + RFC 4648 base32, implemented with node:crypto only.
// Compatible with Google Authenticator, Authy, Microsoft Authenticator, 1Password, etc.
const crypto = require('crypto');

const STEP = 30, DIGITS = 6, WINDOW = 1, ISSUER = 'EliteNexa';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
// Lenient decode: ignores spaces/dashes/padding, case-insensitive. Returns null on invalid characters.
function base32Decode(str) {
  const s = normalizeSecret(str);
  if (!s || /[^A-Z2-7]/.test(s)) return null;
  let bits = 0, value = 0; const out = [];
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const normalizeSecret = (str) => String(str == null ? '' : str).toUpperCase().replace(/[\s\-=]/g, '');
// A usable secret: valid base32 and at least 80 bits (16 chars). Returns the normalized secret or null.
function validSecret(str) {
  const s = normalizeSecret(str); const key = base32Decode(s);
  return key && key.length >= 10 && s.length <= 128 ? s : null;
}
const generateSecret = () => base32Encode(crypto.randomBytes(20)); // 160-bit, 32 chars

function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0); msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}
const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);
const codeAt = (secret, step) => hotp(base32Decode(secret), step);

// Verify a 6-digit code within ±WINDOW steps. A code is accepted only for a step newer than lastStep
// (prevents reuse of the same / an older code). Returns the matched step or null.
function verify(secret, code, lastStep = 0, now = Date.now()) {
  const c = String(code == null ? '' : code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secret); if (!key) return null;
  const cur = stepAt(now); let match = null;
  for (let s = cur - WINDOW; s <= cur + WINDOW; s++) {
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(c));
    if (ok && s > (lastStep || 0) && match === null) match = s;
  }
  return match;
}
const otpauthUri = (secret, account) =>
  `otpauth://totp/${encodeURIComponent(ISSUER)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
const groupSecret = (s) => s.replace(/(.{4})/g, '$1 ').trim();

// ---- encryption at rest (AES-256-GCM, key derived from SESSION_SECRET via HKDF) ----
let ENC_KEY = null, MAC_KEY = null;
function init(sessionSecret) {
  const ikm = Buffer.from(String(sessionSecret));
  ENC_KEY = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from('elitenexa'), Buffer.from('totp-secret-encryption-v1'), 32));
  MAC_KEY = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from('elitenexa'), Buffer.from('backup-code-hash-v1'), 32));
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function decrypt(blob) {
  try {
    const [v, iv, tag, ct] = String(blob || '').split(':'); if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch (_) { return null; }
}

// ---- one-time backup codes: 10 x "xxxxx-xxxxx" (50 bits each), stored as HMAC-SHA256 ----
const BC_ALPHA = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32 (no i, l, o, u)
function generateBackupCodes(n = 10) {
  const out = [];
  while (out.length < n) {
    const b = crypto.randomBytes(10); let s = '';
    for (const x of b) s += BC_ALPHA[x & 31];
    const code = s.slice(0, 5) + '-' + s.slice(5);
    if (!out.includes(code)) out.push(code);
  }
  return out;
}
const normalizeBackup = (c) => String(c == null ? '' : c).toLowerCase().replace(/[\s\-]/g, '').replace(/o/g, '0').replace(/[il]/g, '1');
const looksLikeBackup = (c) => /^[a-z0-9]{10}$/.test(normalizeBackup(c));
const hashBackup = (c) => crypto.createHmac('sha256', MAC_KEY).update(normalizeBackup(c)).digest('hex');

module.exports = { STEP, DIGITS, WINDOW, ISSUER, base32Encode, base32Decode, validSecret, normalizeSecret, generateSecret, hotp, stepAt, codeAt, verify,
  otpauthUri, groupSecret, init, encrypt, decrypt, generateBackupCodes, normalizeBackup, looksLikeBackup, hashBackup };
