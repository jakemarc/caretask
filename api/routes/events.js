// Event-log routes (CareTask demo API audit core).
//
// Endpoints (mounted under /events by server.js, behind requireAuth):
//   GET    /events            list, newest first. Filters: ?event=,
//                              ?actor_email= (partial match),
//                              ?patient_id=, ?from=, ?to= (ISO dates),
//                              ?limit= (default 50, max 200), ?offset=
//   POST   /events            report a client-observed event
//                              (sign_in, sign_out, report_export only)
//   GET    /events/verify     recompute the audit_log + event_log hash
//                              chains and report valid/broken per table
//
// Notes:
// - POST /events accepts ONLY client-reportable events. Server-side
//   events (patient_view, auth_failure, api_request, admin_action)
//   are written by the API itself and are rejected here with 400, so
//   a client can never forge them.
// - All values go through parameterized queries ($1, $2, ...). Never
//   interpolate request input into SQL strings.
// - GET /events returns full rows including prev_hash/row_hash/seq:
//   hashes are integrity evidence, not secrets, and the dashboard
//   viewer shows the chain state from /events/verify alongside them.
const express = require('express');
const pool = require('../db');
const { CLIENT_EVENTS, ALL_EVENTS, insertEvent } = require('../lib/eventLog');
const { verifyAll } = require('../lib/verifyChain');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseLimitOffset(query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

// GET /events — list, newest first. created_at ties (same transaction,
// same millisecond) break on seq, which is monotonic.
router.get('/', async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];
    if (req.query.event !== undefined) {
      if (!ALL_EVENTS.includes(req.query.event)) {
        return res
          .status(400)
          .json({ error: `event must be one of: ${ALL_EVENTS.join(', ')}` });
      }
      params.push(req.query.event);
      conditions.push(`event = $${params.length}`);
    }
    if (req.query.actor_email) {
      params.push(`%${req.query.actor_email}%`);
      conditions.push(`actor_email ILIKE $${params.length}`);
    }
    if (req.query.patient_id) {
      params.push(req.query.patient_id);
      conditions.push(`patient_id = $${params.length}`);
    }
    if (req.query.from !== undefined) {
      const from = new Date(req.query.from);
      if (Number.isNaN(from.getTime())) {
        return res.status(400).json({ error: 'from must be an ISO date' });
      }
      params.push(from.toISOString());
      conditions.push(`created_at >= $${params.length}`);
    }
    if (req.query.to !== undefined) {
      const to = new Date(req.query.to);
      if (Number.isNaN(to.getTime())) {
        return res.status(400).json({ error: 'to must be an ISO date' });
      }
      params.push(to.toISOString());
      conditions.push(`created_at <= $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { limit, offset } = parseLimitOffset(req.query);
    const result = await pool.query(
      `SELECT * FROM event_log ${where} ORDER BY created_at DESC, seq DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /events/verify — recompute both hash chains. Reports per table:
// total rows, legacy (pre-chain, NULL hash) rows, rows checked, whether
// the chain is valid, and the first breaking row when it is not.
// NOTE: this route must be registered BEFORE any /:id-style route if
// one is ever added — Express matches in registration order.
router.get('/verify', async (req, res, next) => {
  try {
    res.json(await verifyAll(pool));
  } catch (err) {
    next(err);
  }
});

// POST /events — report a client-observed event. The actor comes from
// the verified token, never from the body. details, when given, must
// be a plain object; patient_id, when given, must be UUID-shaped.
router.post('/', async (req, res, next) => {
  try {
    const { event, patient_id, details } = req.body || {};
    if (!CLIENT_EVENTS.includes(event)) {
      return res
        .status(400)
        .json({ error: `event must be one of: ${CLIENT_EVENTS.join(', ')}` });
    }
    if (details !== undefined && (details === null || typeof details !== 'object' || Array.isArray(details))) {
      return res.status(400).json({ error: 'details must be an object' });
    }
    if (patient_id !== undefined && patient_id !== null && !UUID_RE.test(patient_id)) {
      return res.status(400).json({ error: 'patient_id must be a UUID' });
    }
    const row = await insertEvent(pool, {
      actor: req.user,
      event,
      patientId: patient_id ?? null,
      details: details ?? {},
      ip: req.ip || null,
    });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
