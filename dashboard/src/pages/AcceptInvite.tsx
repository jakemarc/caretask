import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { auth, googleProvider, isFirebaseConfigured } from "../lib/firebase";
import { acceptInvite, type ApiRequestError } from "../lib/patientApi";
import type { Theme } from "../lib/theme";
import { Moon, Sun } from "lucide-react";
import Mark from "../components/Mark";

// Invite-only sign-up (platform, 2026-11-03): an admin creates an
// invite for an email address; the link lands here with the code.
// The visitor creates their sign-in account (or signs in with the
// one they already have), and the page trades the code for a staff
// record via POST /invites/accept. Until that call succeeds the
// account has no staff record and the API refuses everything —
// so acceptance happens here, before entering the app.
export default function AcceptInvite({
  theme,
  onToggleTheme,
}: {
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [currentUser, setCurrentUser] = useState<User | null | undefined>(
    undefined,
  );
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [fname, setFname] = useState("");
  const [lname, setLname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!auth) {
      setCurrentUser(null);
      return;
    }
    return onAuthStateChanged(auth, setCurrentUser);
  }, []);

  if (currentUser === undefined) return null;

  async function finishAccept(user: User, names?: { fname: string; lname: string }) {
    await acceptInvite(user, {
      code: code.trim(),
      ...(names?.fname ? { fname: names.fname } : {}),
      ...(names?.lname ? { lname: names.lname } : {}),
    });
    setDone(true);
    navigate("/app", { replace: true });
  }

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!auth) return;
    setError("");
    setBusy(true);
    try {
      const cred = await createUserWithEmailAndPassword(
        auth,
        email.trim(),
        password,
      );
      await finishAccept(cred.user, {
        fname: fname.trim(),
        lname: lname.trim(),
      });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleExistingEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!auth) return;
    setError("");
    setBusy(true);
    try {
      const cred = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password,
      );
      await finishAccept(cred.user);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    if (!auth) return;
    setError("");
    setBusy(true);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      await finishAccept(cred.user, {
        fname: fname.trim(),
        lname: lname.trim(),
      });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAcceptSignedIn() {
    if (!currentUser) return;
    setError("");
    setBusy(true);
    try {
      await finishAccept(currentUser, {
        fname: fname.trim(),
        lname: lname.trim(),
      });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
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
        <h1>Accept your invite</h1>
        <p className="login-sub">CareTask Dashboard</p>

        {!isFirebaseConfigured && (
          <p className="setup-notice">
            Sign-in is not connected yet, so invites can't be accepted.
          </p>
        )}

        <label>
          Invite code
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="From your invite link"
            autoComplete="off"
            disabled={!isFirebaseConfigured || busy}
          />
        </label>

        {currentUser ? (
          <>
            <p className="section-note">
              You're signed in as {currentUser.email}. The invite must
              have been sent to this same address.
            </p>
            <div className="form-row">
              <label>
                First name
                <input
                  type="text"
                  value={fname}
                  onChange={(e) => setFname(e.target.value)}
                  autoComplete="given-name"
                  disabled={busy}
                />
              </label>
              <label>
                Last name
                <input
                  type="text"
                  value={lname}
                  onChange={(e) => setLname(e.target.value)}
                  autoComplete="family-name"
                  disabled={busy}
                />
              </label>
            </div>
            {error && <p className="login-error">{error}</p>}
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void handleAcceptSignedIn()}
              disabled={busy || !code.trim() || done}
            >
              {busy ? "Accepting…" : "Accept invite"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                if (auth) void signOut(auth);
              }}
            >
              Use a different account
            </button>
          </>
        ) : (
          <>
            <div className="flag-actions">
              <button
                type="button"
                className={mode === "new" ? "btn btn-primary" : "btn btn-secondary"}
                onClick={() => setMode("new")}
              >
                New account
              </button>
              <button
                type="button"
                className={
                  mode === "existing" ? "btn btn-primary" : "btn btn-secondary"
                }
                onClick={() => setMode("existing")}
              >
                I have an account
              </button>
            </div>
            <form
              onSubmit={
                mode === "new" ? handleCreateAccount : handleExistingEmail
              }
            >
              {mode === "new" && (
                <div className="form-row">
                  <label>
                    First name
                    <input
                      type="text"
                      value={fname}
                      onChange={(e) => setFname(e.target.value)}
                      autoComplete="given-name"
                      disabled={busy}
                    />
                  </label>
                  <label>
                    Last name
                    <input
                      type="text"
                      value={lname}
                      onChange={(e) => setLname(e.target.value)}
                      autoComplete="family-name"
                      disabled={busy}
                    />
                  </label>
                </div>
              )}
              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  disabled={!isFirebaseConfigured || busy}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete={
                    mode === "new" ? "new-password" : "current-password"
                  }
                  disabled={!isFirebaseConfigured || busy}
                />
              </label>
              {error && <p className="login-error">{error}</p>}
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy || !isFirebaseConfigured || !code.trim() || done}
              >
                {busy
                  ? "Working…"
                  : mode === "new"
                    ? "Create account & accept"
                    : "Sign in & accept"}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => void handleGoogle()}
                disabled={busy || !isFirebaseConfigured || !code.trim()}
              >
                Continue with Google
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function friendlyError(err: unknown): string {
  const apiErr = err as ApiRequestError | null;
  switch (apiErr?.code) {
    case "INVITE_INVALID":
      return "That invite code isn't valid. Check the link, or ask the person who invited you for a new one.";
    case "INVITE_USED":
      return "This invite has already been used. If that's you, just sign in.";
    case "INVITE_EXPIRED":
      return "This invite has expired — ask for a fresh one.";
    case "INVITE_EMAIL_MISMATCH":
      return "This invite was sent to a different email address. Sign in with the address it was sent to.";
    case "ALREADY_STAFF":
      return "This account is already on the team — just sign in.";
  }
  if (err instanceof Error) {
    const code = (err as { code?: string }).code ?? "";
    switch (code) {
      case "auth/email-already-in-use":
        return "That email already has an account — use “I have an account” above.";
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
      case "auth/popup-closed-by-user":
        return "The Google sign-in window was closed.";
      default:
        return "Something went wrong. Try again.";
    }
  }
  return "Something went wrong. Try again.";
}
