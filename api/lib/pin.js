// Manager override PIN hashing + lookup (CareTask demo API).
//
// The PIN never lives in the dashboard code or in the database as
// plaintext. users.pin_hash holds a scrypt hash in the format
//   scrypt$<salt base64>$<derived key base64>
// produced by Node's built-in crypto (no extra dependency). Verifying
// re-derives the key from the candidate PIN and compares in constant
// time.
//
// Override model (matches how a manager override works in person): the
// PIN belongs to a manager/admin, NOT to the signed-in user. Any active
// manager/admin's PIN authorizes the write; findManagerByPin returns
// WHICH manager matched so the caller can record the attribution in
// the audit/event log. If two managers somehow share a PIN, the first
// match wins — acceptable for the demo, worth revisiting if PINs ever
// gate real data.
const crypto = require('crypto');

const KEYLEN = 64;
const PIN_FORMAT = /^\d{4,8}$/;

function isPinFormat(pin) {
  return typeof pin === 'string' && PIN_FORMAT.test(pin);
}

function hashPin(pin) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(pin), salt, KEYLEN, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt.toString('base64')}$${key.toString('base64')}`);
    });
  });
}

function verifyPin(pin, stored) {
  return new Promise((resolve) => {
    try {
      const [scheme, saltB64, hashB64] = String(stored || '').split('$');
      if (scheme !== 'scrypt' || !saltB64 || !hashB64) return resolve(false);
      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(hashB64, 'base64');
      crypto.scrypt(String(pin), salt, expected.length, (err, key) => {
        if (err) return resolve(false);
        resolve(key.length === expected.length && crypto.timingSafeEqual(key, expected));
      });
    } catch {
      resolve(false);
    }
  });
}

// Find the active manager/admin whose PIN matches. Returns
// { id, email, role } (never the hash) or null.
async function findManagerByPin(db, pin) {
  if (!isPinFormat(pin)) return null;
  const { rows } = await db.query(
    `SELECT id, email, role, pin_hash FROM users
      WHERE role IN ('manager', 'admin') AND active AND pin_hash IS NOT NULL
      ORDER BY id`,
  );
  for (const row of rows) {
    // Sequential on purpose: few manager rows, and scrypt is slow by
    // design — no point parallelizing a handful of checks.
    if (await verifyPin(pin, row.pin_hash)) {
      return { id: row.id, email: row.email, role: row.role };
    }
  }
  return null;
}

module.exports = { hashPin, verifyPin, findManagerByPin, isPinFormat };
