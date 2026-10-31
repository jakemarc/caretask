import { useRef, useState } from "react";
import type { User } from "firebase/auth";
import { RefreshCw } from "lucide-react";
import {
  isPinRejection,
  syncAgenciesNow,
  verifyManagerPin,
} from "../lib/patientApi";

// Manual sync trigger for the IDPH agency directory, used in
// Settings → Agency directory ("Update agencies") — calls the
// PIN-gated POST /agencies/sync. Slimmed at Jake's direction
// (2026-10-30): just the button plus the PIN prompt and the
// outcome of a run; the standing status text (source label,
// last synced, directory size, auto-sync blurb) was removed.
// The directory also refreshes itself weekly on the server
// (systemd timer, caretask-agency-sync.timer). Errors are
// shown plainly, never swallowed.

export default function AgencySyncPanel({
  user,
  apiConnected,
  buttonLabel = "Sync now",
  onSynced,
}: {
  user: User;
  apiConnected: boolean;
  buttonLabel?: string;
  onSynced?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pinPrompt, setPinPrompt] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const pinRef = useRef<string | null>(null);
  const pendingResolveRef = useRef<((pin: string | null) => void) | null>(
    null,
  );

  function ensurePin(): Promise<string | null> {
    if (pinRef.current) return Promise.resolve(pinRef.current);
    return new Promise((resolve) => {
      setPinError(null);
      setPinInput("");
      setPinPrompt(true);
      // Resolved by submitPin / cancelPin below.
      pendingResolveRef.current = resolve;
    });
  }

  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    const pin = pinInput.trim();
    if (!pin) return;
    try {
      await verifyManagerPin(user, pin);
    } catch (err) {
      setPinError(
        isPinRejection(err)
          ? "That PIN was not accepted. Syncs need an active manager or admin PIN."
          : "Could not verify the PIN — the API may be unreachable. Nothing was changed.",
      );
      return;
    }
    pinRef.current = pin;
    setPinPrompt(false);
    pendingResolveRef.current?.(pin);
    pendingResolveRef.current = null;
  }

  function cancelPin() {
    setPinPrompt(false);
    pendingResolveRef.current?.(null);
    pendingResolveRef.current = null;
  }

  async function runSync() {
    const pin = await ensurePin();
    if (!pin) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const summary = await syncAgenciesNow(user, pin);
      setNote(
        summary.skipped_no_change
          ? "Already up to date — IDPH has not published a newer directory since the last sync, so nothing was changed."
          : `Sync complete: ${summary.inserted} new, ${summary.updated} updated, ${summary.deactivated} deactivated (of ${summary.fetched} fetched).`,
      );
      onSynced?.();
    } catch (err) {
      if (isPinRejection(err)) pinRef.current = null;
      setError(
        err instanceof Error
          ? `Sync failed: ${err.message}`
          : "Sync failed for an unknown reason.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {!apiConnected ? (
        <p className="card-meta">
          The CareTask API is not connected right now, so updating
          the directory is unavailable.
        </p>
      ) : (
        <>
          {error && (
            <p className="danger-note" role="alert">
              {error}
            </p>
          )}
          {note && <p className="card-meta">{note}</p>}
          <div className="flag-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void runSync()}
            >
              <RefreshCw size={15} /> {busy ? "Syncing…" : buttonLabel}
            </button>
          </div>
          {pinPrompt && (
            <form className="pin-panel" onSubmit={submitPin}>
              <label className="pin-label" htmlFor="agency-sync-pin">
                Manager PIN required to sync the agency directory
              </label>
              <div className="pin-row">
                <input
                  id="agency-sync-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  placeholder="Manager PIN"
                />
                <button type="submit" className="btn btn-primary">
                  Verify &amp; sync
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={cancelPin}
                >
                  Cancel
                </button>
              </div>
              {pinError && (
                <p className="danger-note" role="alert">
                  {pinError}
                </p>
              )}
            </form>
          )}
        </>
      )}
    </div>
  );
}
