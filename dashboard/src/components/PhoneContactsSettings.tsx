// Settings card: phone contacts sync (CardDAV, 2026-11-03).
// Mirrors the caller's Active patient list into a phone address
// book named "CareTask" on our own CardDAV server. The CardDAV
// password is shown exactly once (enable / regenerate) — it is
// never stored in the API database, so it can't be shown again.
import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  disableContactSync,
  enableContactSync,
  fetchContactSync,
  regenerateContactSyncPassword,
  syncContactsNow,
  type ContactSyncCredentials,
  type ContactSyncStatus,
} from "../lib/patientApi";

interface Props {
  user: User;
  apiConnected: boolean;
}

export function PhoneContactsCard({ user, apiConnected }: Props) {
  const [status, setStatus] = useState<ContactSyncStatus | null>(null);
  const [creds, setCreds] = useState<ContactSyncCredentials | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const [notice, setNotice] = useState("");

  const load = async () => {
    try {
      setStatus(await fetchContactSync(user));
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    if (apiConnected) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiConnected]);

  if (!apiConnected) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const onEnable = () =>
    run(async () => {
      const c = await enableContactSync(user);
      setCreds(c);
      await load();
    });

  const onRegenerate = () =>
    run(async () => {
      const c = await regenerateContactSyncPassword(user);
      setCreds(c);
    });

  const onSyncNow = () =>
    run(async () => {
      const s = await syncContactsNow(user);
      if (s?.error) setError(`Sync failed: ${s.error}`);
      else setNotice("Contacts are up to date.");
      await load();
    });

  const onDisable = () =>
    run(async () => {
      await disableContactSync(user);
      setCreds(null);
      setConfirmOff(false);
      await load();
    });

  const fmtTime = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString() : null;

  return (
    <article className="card">
      <div className="card-top">
        <strong>Phone contacts</strong>
      </div>
      <p>
        Keep your Active patients in your phone's Contacts, in a
        list named <strong>CareTask</strong> — callers show their
        names, and a patient is one tap to call. Only names,
        phone numbers, email, and address sync; nothing clinical
        ever leaves CareTask. The list updates on its own when a
        patient becomes active, goes on hold, or is discharged.
      </p>
      {status === null ? (
        <p className="section-note">Loading…</p>
      ) : !status.configured ? (
        <p className="section-note">
          Phone sync isn't set up on the server yet.
        </p>
      ) : !status.enabled ? (
        <>
          <div className="flag-actions">
            <button className="btn btn-primary" disabled={busy} onClick={onEnable}>
              Turn on phone sync
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="section-note">
            On · {status.contact_count}{" "}
            {status.contact_count === 1 ? "contact" : "contacts"}
            {status.last_sync_at
              ? ` · last synced ${fmtTime(status.last_sync_at)}`
              : ""}
            {status.last_result && status.last_result !== "ok"
              ? ` · ${status.last_result}`
              : ""}
          </p>
          <div className="flag-actions">
            <button className="btn btn-secondary" disabled={busy} onClick={onSyncNow}>
              Sync now
            </button>
            <button className="btn btn-secondary" disabled={busy} onClick={onRegenerate}>
              New password
            </button>
            {confirmOff ? (
              <>
                <button className="btn btn-danger" disabled={busy} onClick={onDisable}>
                  Confirm turn off
                </button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirmOff(false)}>
                  Keep on
                </button>
              </>
            ) : (
              <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirmOff(true)}>
                Turn off
              </button>
            )}
          </div>
          <p className="section-note">
            Turning off removes the CareTask list from the server
            right away; the contacts disappear from your phone
            with the account.
          </p>
        </>
      )}
      {notice ? <p className="section-note">{notice}</p> : null}
      {error ? <p className="pin-error">{error}</p> : null}
      {creds ? (
        <div className="dup-panel">
          <p>
            <strong>Your CardDAV sign-in — shown only this once.</strong>{" "}
            Save the password now; it can't be displayed again
            (you can always make a new one).
          </p>
          <ul className="schedule-list">
            <li className="schedule-item">
              <span>Server</span>
              <strong>{creds.server_url ?? status?.server_url}</strong>
            </li>
            <li className="schedule-item">
              <span>Username</span>
              <strong>{creds.dav_username}</strong>
            </li>
            <li className="schedule-item">
              <span>Password</span>
              <strong>{creds.password}</strong>
            </li>
          </ul>
          <p>
            On your iPhone: Settings → Apps → Contacts → Contacts
            Accounts → Add Account → Other → Add CardDAV Account.
            Enter the server, username, and password above, with
            the description <strong>CareTask</strong>. Your
            patients then appear under Contacts → Lists →
            CareTask. (Android: same details in the DAVx5 app.)
          </p>
          <div className="flag-actions">
            <button className="btn btn-secondary" onClick={() => setCreds(null)}>
              I've saved it
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
