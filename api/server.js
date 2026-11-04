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
//   AND an active staff record (lib/platform.js requireStaff).
//   Page-level login alone is not protection: anyone who finds the
//   API URL could call it directly, so the token + staff-record
//   checks here are the real gate. Staff records are provisioned
//   through the invite system (routes/invites.js); the old
//   ALLOWED_EMAILS allowlist was retired 2026-11-03.
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
const { requireStaff } = require('./lib/platform');
const requestLogger = require('./lib/requestLog');
const patientsRouter = require('./routes/patients');
const eventsRouter = require('./routes/events');
const usersRouter = require('./routes/users');
const appointmentsRouter = require('./routes/appointments');
const messagesRouter = require('./routes/messages');
const documentsRouter = require('./routes/documents');
const agenciesRouter = require('./routes/agencies');
const expensesRouter = require('./routes/expenses');
const patientMergeRouter = require('./routes/patientMerge');
const tasksRouter = require('./routes/tasks');
const newsRouter = require('./routes/news');
const episodesRouter = require('./routes/episodes');
const invitesRouter = require('./routes/invites');
const contactSyncRouter = require('./routes/contactSync');
const adminRouter = require('./routes/admin');
const { startContactSyncTimer } = require('./lib/contactSync');

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
  // Per-deployment preview origins of the dashboard project
  // (https://<hash>.marcinnotech-app.pages.dev) are allowed too
  // (Jake-approved widening, 2026-11-02) so a preview build can
  // be checked against the live API before it goes canonical.
  // The main origin still comes from DASHBOARD_ORIGIN.
  const previewOrigin =
    /^https:\/\/[a-z0-9-]+\.marcinnotech-app\.pages\.dev$/;
  app.use(
    cors({
      origin: (origin, cb) => {
        if (
          !origin ||
          allowedOrigins.includes(origin) ||
          previewOrigin.test(origin)
        ) {
          cb(null, true);
        } else {
          cb(new Error('CORS origin not allowed'));
        }
      },
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
// Multi-user platform (2026-11-03): a verified token is no longer
// enough — every router below also sits behind the staff-record
// gate (requireStaff, 403 NO_STAFF_RECORD). Staff records are
// provisioned through invites, so /invites mounts behind
// requireAuth ONLY (its accept route creates the staff record).
app.use('/invites', requireAuth, invitesRouter);
app.use('/patients', requireAuth, requireStaff, patientsRouter);
app.use('/events', requireAuth, requireStaff, eventsRouter);
app.use('/users', requireAuth, requireStaff, usersRouter);
app.use('/appointments', requireAuth, requireStaff, appointmentsRouter);
app.use('/messages', requireAuth, requireStaff, messagesRouter);
app.use('/documents', requireAuth, requireStaff, documentsRouter);
app.use('/agencies', requireAuth, requireStaff, agenciesRouter);
// Expense reports: the router carries its own path prefixes
// (/expense-reports/*, /mileage/route) so it mounts at root.
app.use('/', requireAuth, requireStaff, expensesRouter);
app.use('/patient-merge', requireAuth, requireStaff, patientMergeRouter);
app.use('/tasks', requireAuth, requireStaff, tasksRouter);
app.use('/news', requireAuth, requireStaff, newsRouter);
// Episodes: the router carries full paths (/patients/:id/episodes,
// /episodes/:id/...) so it mounts at root, after the patients router.
app.use('/', requireAuth, requireStaff, episodesRouter);
// Phone contacts sync (CardDAV): per-clinician self-service under
// /contact-sync/me. Inert unless the CARDDAV_* env is configured.
app.use('/contact-sync', requireAuth, requireStaff, contactSyncRouter);
startContactSyncTimer();
// Admin console API (admin.marcinnotech.net): read-only
// aggregates; the router adds the platform-admin role gate
// (admin/developer) on top of the staff gate here.
app.use('/admin', requireAuth, requireStaff, adminRouter);

// Error handler: log the real error server-side, send a generic message.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`CareTask patient API listening on http://127.0.0.1:${PORT} (localhost only)`);
});
