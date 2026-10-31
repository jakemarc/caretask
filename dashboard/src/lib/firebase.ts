import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";

// Company Firebase web app config, supplied through environment variables.
// This is deliberately NOT the config of any personal project: the company
// app must point at the company's own Firebase project (see README.md).
// Firebase web config values are public client identifiers, not secrets —
// but no config of any kind is checked in here; .env is git-ignored.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as
    | string
    | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as
    | string
    | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.authDomain &&
    firebaseConfig.projectId &&
    firebaseConfig.appId,
);

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  authInstance = getAuth(app);
}

export { app };

// Null until the company Firebase config is supplied. Callers must check
// isFirebaseConfigured first; the login page shows a setup notice instead
// of sign-in buttons when this is null.
export const auth: Auth | null = authInstance;
export const googleProvider = new GoogleAuthProvider();
