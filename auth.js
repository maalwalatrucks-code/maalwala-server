// auth.js — password hashing + session tokens using only Node's
// built-in crypto module (no new npm dependency needed).
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  // timing-safe comparison
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------- OTP (mobile login) ----------
function generateOtp() {
  return String(crypto.randomInt(100000, 1000000)); // 6 digits, 100000-999999
}
function hashOtp(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}
function verifyOtp(code, hash) {
  const a = Buffer.from(hashOtp(code), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { hashPassword, verifyPassword, generateToken, generateOtp, hashOtp, verifyOtp };
