// Firebase ID-token verification for the CareTask patient API.
//
// Same pattern as the reference MarcDB API (jakemarc-fullstack/api/auth.js):
// the dashboard signs in with Firebase Auth, gets the user's ID token, and
// sends it as `Authorization: Bearer <token>`. This middleware verifies the
// token ONLY. Who may actually use the API is decided one layer up: the
// caller must resolve to an active staff record (lib/platform.js
// requireStaff), which is provisioned through the invite system. The
// old ALLOWED_EMAILS allowlist was retired with the multi-user platform
// (2026-11-03) — the invite is the perimeter now. /invites/accept is
// the one route mounted behind requireAuth WITHOUT the staff gate,
// because accepting an invite is how a staff record comes to exist.
//
// Verification needs NO private key on the VM, by design: checking a token's
// signature uses Google's public keys, and this API never mints tokens or
// performs admin actions. So instead of a service-account JSON file, the
// SDK is initialized with only the Firebase project ID, which must match
// the project the dashboard signs into (the MARC INNOTECH Firebase project).
//
// Setup (on the VM, never in chat or in the repo):
// 1. Set FIREBASE_PROJECT_ID to the dashboard's Firebase project ID.
//    The server refuses to start without it (fail fast, not fail open).
// 2. The VM must be able to reach Google over HTTPS to fetch the public
//    keys used to verify tokens.
const admin = require('firebase-admin');

let app = null;
function getAdmin() {
  if (!app) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
      throw new Error('FIREBASE_PROJECT_ID is required');
    }
    // Project ID only — verification uses Google's public keys, so no
    // service-account private key is stored on the VM.
    app = admin.initializeApp({ projectId });
  }
  return app;
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
      req.authFailure = { reason: 'missing_or_malformed_header' };
      return res.status(401).json({ error: 'missing or invalid Authorization header' });
    }
    const decoded = await getAdmin().auth().verifyIdToken(match[1]);
    const email = (decoded.email || '').toLowerCase();
    req.user = { uid: decoded.uid, email };
    next();
  } catch (err) {
    req.authFailure = { reason: 'token_verification_failed', code: err.code || 'unknown' };
    console.error('auth failed:', err.code || '', err.message);
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

module.exports = requireAuth;
