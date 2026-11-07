import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { auth, isFirebaseConfigured } from "../lib/firebase";
import {
  consumeGoogleRedirectResult,
  googleAuthErrorMessage,
  signInWithGoogle,
} from "../lib/googleAuth";
import type { Theme } from "../lib/theme";
import { Moon, Sun } from "lucide-react";
import Mark from "../components/Mark";

// Sign-in only: there is no public registration in this app.
// New users join by invite — an admin sends one from Settings,
// and the invite link lands on /accept-invite.
export default function Login({
  theme,
  onToggleTheme,
}: {
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!auth) {
      setChecking(false);
      return;
    }
    void consumeGoogleRedirectResult(auth).catch((err) => {
      setError(googleAuthErrorMessage(err) || friendlyError(err));
    });
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) navigate("/app", { replace: true });
      else setChecking(false);
    });
    return unsub;
  }, [navigate]);

  if (checking) return null;

  async function handleEmailAuth(e: React.FormEvent) {
    e.preventDefault();
    if (!auth) return;
    setError("");
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      navigate("/app");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogleSignIn() {
    if (!auth) return;
    setError("");
    setBusy(true);
    let redirecting = false;
    try {
      const outcome = await signInWithGoogle(auth);
      if (outcome.status === "signed-in") navigate("/app");
      else redirecting = true;
    } catch (err) {
      setError(googleAuthErrorMessage(err) || friendlyError(err));
    } finally {
      if (!redirecting) setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <Mark size={48} />
          <div>
            <p className="brand-name">MARC INNOTECH</p>
            <p className="brand-tag">
              Empowering clinicians to provide modern medical care
            </p>
          </div>
          <button
            className="btn btn-ghost theme-toggle"
            type="button"
            onClick={onToggleTheme}
            title={
              theme === "light"
                ? "Switch to dark mode"
                : "Switch to light mode"
            }
            aria-label={
              theme === "light"
                ? "Switch to dark mode"
                : "Switch to light mode"
            }
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
        <h1>Sign in</h1>
        <p className="login-sub">CareTask Dashboard</p>

        {!isFirebaseConfigured && (
          <p className="setup-notice">
            Sign-in is not connected yet. Add the company Firebase web app
            config to <code>.env</code> (see README.md) and rebuild — no
            accounts can sign in until then.
          </p>
        )}

        <form onSubmit={handleEmailAuth}>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              disabled={!isFirebaseConfigured}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              disabled={!isFirebaseConfigured}
            />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || !isFirebaseConfigured}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={handleGoogleSignIn}
            disabled={busy || !isFirebaseConfigured}
          >
            Continue with Google
          </button>
        </form>
        <p className="section-note">
          Have an invite?{" "}
          <a href="/accept-invite">Accept it here</a> — CareTask is
          invite-only.
        </p>
      </div>
    </div>
  );
}

function friendlyError(err: unknown): string {
  if (err instanceof Error) {
    const googleMessage = googleAuthErrorMessage(err);
    if (googleMessage) return googleMessage;
    const code = (err as { code?: string }).code ?? "";
    switch (code) {
      case "auth/invalid-credential":
      case "auth/wrong-password":
      case "auth/user-not-found":
        return "That email or password doesn't match an account.";
      case "auth/weak-password":
        return "Password needs to be at least 6 characters.";
      case "auth/invalid-email":
        return "That email address doesn't look right.";
      case "auth/too-many-requests":
        return "Too many attempts — try again in a bit.";
      case "auth/operation-not-allowed":
        return "This sign-in method isn't enabled yet.";
      case "auth/popup-closed-by-user":
        return "The Google sign-in window was closed.";
      default:
        return "Couldn't sign you in. Try again.";
    }
  }
  return "Couldn't sign you in. Try again.";
}
