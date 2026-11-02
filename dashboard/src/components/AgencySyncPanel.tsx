import { useState } from "react";
import type { User } from "firebase/auth";
import { RefreshCw } from "lucide-react";
import { isRoleRejection, syncAgenciesNow } from "../lib/patientApi";
import { isManagerRole, useMyStaff } from "../lib/useMyRole";

// Manual sync trigger for the IDPH agency directory, used in
// Settings → Agency directory ("Update agencies") — calls the
// role-gated POST /agencies/sync (manager/admin; the manager PIN
// was retired on 2026-11-02). Slimmed at Jake's direction
// (2026-10-30): just the button and the outcome of a run; the
// standing status text (source label, last synced, directory
// size, auto-sync blurb) was removed. The directory also
// refreshes itself weekly on the server (systemd timer,
// caretask-agency-sync.timer). Errors are shown plainly, never
// swallowed.

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
  const me = useMyStaff(user);
  const isManager = isManagerRole(me);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function runSync() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const summary = await syncAgenciesNow(user);
      setNote(
        summary.skipped_no_change
          ? "Already up to date — IDPH has not published a newer directory since the last sync, so nothing was changed."
          : `Sync complete: ${summary.inserted} new, ${summary.updated} updated, ${summary.deactivated} deactivated (of ${summary.fetched} fetched).`,
      );
      onSynced?.();
    } catch (err) {
      setError(
        isRoleRejection(err)
          ? "Syncing the directory needs a manager or admin role."
          : err instanceof Error
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
      ) : !isManager ? (
        <p className="card-meta">
          Syncing the directory needs a manager or admin role. The
          directory also refreshes itself weekly on the server.
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
        </>
      )}
    </div>
  );
}
