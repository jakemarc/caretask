// Role gates — these replaced the manager-PIN gate on 2026-11-02
// (Jake's decision: "Remove the PIN — role gates instead"; see
// DECISIONS.md). The PIN model let any signed-in user perform a
// manager action by borrowing a manager's PIN; the role model
// ties the authority to the signed-in account's own staff role,
// which the users table already carries.
//
// Two middlewares:
// - requireRole(...roles): the caller must resolve to an ACTIVE
//   users row whose role is in the list, else 403
//   (NO_STAFF_RECORD when there is no row, ROLE_REQUIRED when
//   the role is wrong). On success it sets req.staff AND
//   req.manager = { id, email, role } of the CALLER, preserving
//   the shape the gated handlers already use to attribute the
//   authorizing manager in their audit/event details — under
//   role gates the authorizer IS the caller, so the attribution
//   stays truthful.
// - attachManager: non-gating variant for routes that dropped
//   their gate entirely (patient update, appointment update)
//   but still record manager_* attribution fields; falls back
//   to the caller's email when they have no staff row.
const pool = require('../db');

async function staffForEmail(email) {
  const { rows } = await pool.query(
    'SELECT id, email, role FROM users WHERE lower(email) = lower($1) AND active = true LIMIT 1',
    [email],
  );
  return rows[0] || null;
}

function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      const staff = await staffForEmail(req.user.email);
      if (!staff) {
        return res
          .status(403)
          .json({ error: 'no active staff record', code: 'NO_STAFF_RECORD' });
      }
      if (!roles.includes(staff.role)) {
        return res
          .status(403)
          .json({ error: 'your role cannot perform this action', code: 'ROLE_REQUIRED' });
      }
      req.staff = staff;
      req.manager = { id: staff.id, email: staff.email, role: staff.role };
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function attachManager(req, res, next) {
  try {
    const staff = await staffForEmail(req.user.email);
    if (staff) req.staff = staff;
    req.manager = staff
      ? { id: staff.id, email: staff.email, role: staff.role }
      : { id: null, email: req.user.email, role: null };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireRole, attachManager };
