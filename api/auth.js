// Firebase ID-token verification for the CareTask patient API.
//
// Same pattern as the reference MarcDB API (jakemarc-fullstack/api/auth.js):
// the dashboard signs in with Firebase Auth, gets the user's ID token, and
// sends it as `Authorization: Bearer <token>`. This middleware verifies the
// token and then checks the user against an allowlist.
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
// 2. Set ALLOWED_EMAILS to the sign-in emails allowed to use the API,
//    comma-separated. The allowlist FAILS CLOSED: if it is unset or empty,
//    every request is rejected. That is deliberate — a signed-in account
//    alone is not a real restriction.
// 3. The VM must be able to reach Google over HTTPS to fetch the public
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

function allowedEmails() {
  return (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
      return res.status(401).json({ error: 'missing or invalid Authorization header' });
    }
    const decoded = await getAdmin().auth().verifyIdToken(match[1]);
    const email = (decoded.email || '').toLowerCase();
    const allowed = allowedEmails();
    if (!allowed.includes(email)) {
      return res.status(403).json({ error: 'account is not on the API allowlist' });
    }
    req.user = { uid: decoded.uid, email };
    next();
  } catch (err) {
    console.error('auth failed:', err.message);
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

module.exports = requireAuth;
