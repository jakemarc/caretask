import {
  getRedirectResult,
  signInWithPopup,
  signInWithRedirect,
  type Auth,
  type UserCredential,
} from "firebase/auth";
import { googleProvider } from "./firebase";

// Google sign-in for browsers where the popup flow is fragile:
// managed tablets, Android WebViews, kiosk browsers, and Chrome
// profiles that block popups or third-party sign-in cookies.
// Desktop keeps the popup. Android goes straight to Firebase's
// full-page redirect flow; other browsers fall back to redirect
// when Firebase reports that the popup path is blocked or not
// supported in this environment.

const REDIRECT_PENDING_KEY = "caretask-google-redirect-pending";

const POPUP_FALLBACK_CODES = new Set([
  "auth/popup-blocked",
  "auth/cancelled-popup-request",
  "auth/operation-not-supported-in-this-environment",
  "auth/web-storage-unsupported",
]);

export type GoogleSignInOutcome =
  | { status: "signed-in"; credential: UserCredential }
  | { status: "redirecting" };

function authCode(err: unknown): string {
  return err instanceof Error ? ((err as { code?: string }).code ?? "") : "";
}

function markRedirectPending() {
  try {
    sessionStorage.setItem(REDIRECT_PENDING_KEY, "1");
  } catch {
    // Storage can itself be blocked in the same environments
    // that block popups; the redirect still works without it.
  }
}

function clearRedirectPending() {
  try {
    sessionStorage.removeItem(REDIRECT_PENDING_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

function prefersGoogleRedirect(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // Android browsers and WebViews are where popup sign-in most
  // often dies silently (custom tabs, managed profiles, and
  // embedded browsers). Redirect is slower but much harder to
  // block halfway.
  return /Android/i.test(ua) || /; wv\)|\bwv\b|WebView/i.test(ua);
}

async function startRedirect(auth: Auth): Promise<GoogleSignInOutcome> {
  markRedirectPending();
  await signInWithRedirect(auth, googleProvider);
  return { status: "redirecting" };
}

export async function signInWithGoogle(
  auth: Auth,
): Promise<GoogleSignInOutcome> {
  if (prefersGoogleRedirect()) return startRedirect(auth);
  try {
    const credential = await signInWithPopup(auth, googleProvider);
    return { status: "signed-in", credential };
  } catch (err) {
    if (POPUP_FALLBACK_CODES.has(authCode(err))) {
      return startRedirect(auth);
    }
    throw err;
  }
}

export async function consumeGoogleRedirectResult(
  auth: Auth,
): Promise<UserCredential | null> {
  try {
    const result = await getRedirectResult(auth);
    if (result) clearRedirectPending();
    return result;
  } catch (err) {
    clearRedirectPending();
    throw err;
  }
}

export function googleAuthErrorMessage(err: unknown): string {
  switch (authCode(err)) {
    case "auth/popup-blocked":
    case "auth/cancelled-popup-request":
      return "Google sign-in was blocked by this browser. Try the full-page Google sign-in, or use email and password on this device.";
    case "auth/operation-not-supported-in-this-environment":
    case "auth/web-storage-unsupported":
      return "This browser blocks the storage Google sign-in needs. Open the app in Chrome with cookies/site data allowed, or use email and password.";
    case "auth/unauthorized-domain":
      return "Google sign-in is not allowed from this app address yet. Use email and password, or open the main CareTask address.";
    case "auth/account-exists-with-different-credential":
      return "That email already signs in a different way. Use the original sign-in method for that account.";
    case "auth/popup-closed-by-user":
      return "The Google sign-in window was closed before it finished.";
    default:
      return "";
  }
}
