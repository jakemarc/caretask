// CareTask demo patient API server. Mounts the patients CRUD under
// /patients, the event log under /events, users under /users,
// appointments under /appointments, messages under /messages,
// clinical documents under /documents, and the IDPH agency
// directory under /agencies.
//
// SECURITY — read before exposing this beyond the VM:
// - This server binds 127.0.0.1 (localhost) only, on purpose. On the VM
//   it sits behind a reverse proxy (Caddy) that terminates TLS for
//   api.marcinnotech.net. Never bind it publicly without TLS in front.
// - /patients and /events require a Firebase ID token (see auth.js)
//   AND an email on the ALLOWED_EMAILS allowlist. Page-level login
//   alone is not protection: anyone who finds the API URL could call
//   it directly, so the token check here is the real gate.
// - Every request (except /health and /events themselves) is logged
//   to event_log by lib/requestLog.js — method, path, status, actor,
//   patient when applicable, IP. Never tokens, passwords, or bodies.
// - CORS is restricted to DASHBOARD_ORIGIN (comma-separated origins).
//   If DASHBOARD_ORIGIN is unset, CORS is off entirely — browser calls
//   from the dashboard will be blocked until it is set. That is
//   deliberate: the allowed origin must be an explicit decision.
// - DEMO DATA ONLY. No real patient data through this API until TLS +
//   a signed BAA + the company entity are all in place. Audit history
//   and soft delete are implemented (see schema.sql, routes/patients.js).
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const requireAuth = require('./auth');
const requestLogger = require('./lib/requestLog');
const patientsRouter = require('./routes/patients');
const eventsRouter = require('./routes/events');
const usersRouter = require('./routes/users');
const appointmentsRouter = require('./routes/appointments');
const messagesRouter = require('./routes/messages');
const documentsRouter = require('./routes/documents');
const agenciesRouter = require('./routes/agencies');
const expensesRouter = require('./routes/expenses');

// Fail fast at boot if the Firebase project is not configured: without it,
// token verification cannot work, and silently rejecting everything would
// look like an auth problem instead of a config problem.
if (!process.env.FIREBASE_PROJECT_ID) {
  throw new Error('FIREBASE_PROJECT_ID is required');
}

const app = express();

const allowedOrigins = (process.env.DASHBOARD_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn(
    'DASHBOARD_ORIGIN is unset: CORS is off and dashboard browser calls will be blocked. Set DASHBOARD_ORIGIN to the dashboard origin to enable it.',
  );
} else {
  app.use(
    cors({
      origin: allowedOrigins,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Manager-Pin'],
    }),
  );
}

app.use(express.json());

// Request logging wraps every route below it (including failed-auth
// requests — the logger runs before requireAuth answers). /health and
// /events are excluded inside the middleware itself.
app.use(requestLogger(pool));

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/patients', requireAuth, patientsRouter);
app.use('/events', requireAuth, eventsRouter);
app.use('/users', requireAuth, usersRouter);
app.use('/appointments', requireAuth, appointmentsRouter);
app.use('/messages', requireAuth, messagesRouter);
app.use('/documents', requireAuth, documentsRouter);
app.use('/agencies', requireAuth, agenciesRouter);
// Expense reports: the router carries its own path prefixes
// (/expense-reports/*, /mileage/route) so it mounts at root.
app.use('/', requireAuth, expensesRouter);

// Error handler: log the real error server-side, send a generic message.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`CareTask patient API listening on http://127.0.0.1:${PORT} (localhost only)`);
});
