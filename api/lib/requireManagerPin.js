// Express middleware: manager PIN override gate for sensitive writes
// (patient update / soft-delete / restore).
//
// The client sends the PIN in the X-Manager-Pin header. Missing header
// → 403 PIN_REQUIRED; present but matching no active manager/admin →
// 403 PIN_INVALID. On success, req.manager = { id, email, role } of
// the manager whose PIN matched, so handlers can attribute the
// override in the audit/event trail.
//
// This replaces the demo's original client-side PIN (a constant in the
// dashboard bundle that anyone could read). The check is server-side
// only now; the dashboard's verify call is a UX convenience, and this
// middleware is the actual enforcement.
const pool = require('../db');
const { findManagerByPin, isPinFormat } = require('./pin');

async function requireManagerPin(req, res, next) {
  const pin = req.headers['x-manager-pin'];
  if (!pin) {
    return res.status(403).json({ error: 'manager PIN required', code: 'PIN_REQUIRED' });
  }
  if (!isPinFormat(String(pin))) {
    return res.status(403).json({ error: 'incorrect manager PIN', code: 'PIN_INVALID' });
  }
  try {
    const manager = await findManagerByPin(pool, String(pin));
    if (!manager) {
      return res.status(403).json({ error: 'incorrect manager PIN', code: 'PIN_INVALID' });
    }
    req.manager = manager;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireManagerPin;
