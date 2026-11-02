// API request logging middleware (OpenEMR's api_log equivalent,
// folded into event_log so there is one chain and one viewer).
//
// Mounted in server.js BEFORE the routers, so it wraps every request
// including ones that fail auth. On response finish it writes one
// event_log row: api_request for ordinary calls, auth_failure for
// 401/403 responses. What it records, and nothing more:
//   method, path (no query string — query params are never logged),
//   response status, actor (from the verified token, when there is
//   one), patient_id when the route carries a UUID id, IP, timestamp.
// It NEVER records tokens, passwords, or request bodies.
//
// Two exclusions, both deliberate — and both apply ONLY to ordinary
// requests, never to auth failures:
// - /health: liveness probes would flood the log with noise.
// - /events: POST /events already IS the event record (sign_in and
//   friends); logging the request too would double every client event,
//   and GET /events polling would flood the log with viewer reads.
// A 401/403 on an excluded path is still logged as auth_failure: a
// failed auth attempt is a security event, not noise, and skipping it
// would blind the log exactly where probing happens (an attacker
// guessing at /events would otherwise leave no trace).
//
// Failure policy: logging is best-effort and fire-and-forget. If the
// insert fails (DB down, for example), the error is swallowed — a
// logging failure must never fail the clinician's request. The
// 'anonymous' actor below is the honest value for requests with no
// verified token: event_log actor columns are NOT NULL, and inventing
// an email would be worse than naming the absence.
const { insertEvent } = require('./eventLog');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANONYMOUS = { uid: 'anonymous', email: 'anonymous' };

function requestLogger(pool) {
  return (req, res, next) => {
    // Capture the client-visible path NOW, at middleware entry. By
    // the time the response finishes, Express routers have rewritten
    // req.path to the in-router remainder (POST /patients logs as
    // '/' if read at finish time) — verified by probe 2026-10-29.
    // originalUrl is never rewritten, so its pathname is the true
    // client path regardless of mount point. The patient id is the
    // first UUID-shaped path segment, read from that same snapshot
    // (req.params is empty before routing and unreliable after it).
    // Only the actor is read at finish time: req.user is set by the
    // auth middleware during routing, which runs before the response
    // ends — except for auth failures, where it stays unset and the
    // request is honestly logged as 'anonymous'.
    const rawUrl = req.originalUrl || req.url || '';
    const path = rawUrl.split('?')[0] || '/';
    const excluded =
      path === '/health' || path === '/events' || path.startsWith('/events/');
    const uuidSegment = path.split('/').find((seg) => UUID_RE.test(seg));
    const patientId = uuidSegment || null;
    res.on('finish', () => {
      const status = res.statusCode;
      // Excluded paths skip logging — unless the request failed auth,
      // which is always a security event worth recording.
      if (excluded && status !== 401 && status !== 403) return;
      const actor = req.user || ANONYMOUS;
      insertEvent(pool, {
        actor,
        event: status === 401 || status === 403 ? 'auth_failure' : 'api_request',
        patientId,
        details: {
          method: req.method,
          path,
          status,
          ...(req.authFailure ? { auth: req.authFailure } : {}),
        },
        ip: req.ip || null,
      }).catch(() => {
        // Best-effort only: never fail a request over its log row.
      });
    });
    next();
  };
}

module.exports = requestLogger;
