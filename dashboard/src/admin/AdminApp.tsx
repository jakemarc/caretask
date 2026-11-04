// CareTask Admin — the administrators-only console served on
// admin.marcinnotech.net (admin-site-spec.md). Same Firebase
// sign-in as the clinician app; right after sign-in it probes
// GET /admin/overview, and a 403 renders the named
// "Administrators only" wall (the API's role gate is the real
// wall — this is just its face). Mission Control skin,
// dark-only, via ./admin.css; the clinician app's theme
// settings do not apply here.
import { useCallback, useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { auth, googleProvider, isFirebaseConfigured } from "../lib/firebase";
import Mark from "../components/Mark";
import {
  createInvite,
  deactivateStaff,
  fetchAdminOverview,
  listAdminUsers,
  listEvents,
  listInvites,
  restoreStaff,
  revokeInvite,
  updateStaff,
  verifyChain,
  type AdminOverview,
  type AdminUserRow,
  type ApiEvent,
  type ApiInvite,
  type ApiRequestError,
  type ChainVerification,
} from "../lib/patientApi";
import "./admin.css";

const MAIN_APP_ORIGIN = "https://marcinnotech-app.pages.dev";
const ROLES = [
  "clinician",
  "manager",
  "admin",
  "developer",
  "support",
  "billing",
  "front_office",
];

function fmtDT(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function fullName(u: AdminUserRow): string {
  const parts = [u.fname, u.mname, u.lname, u.suffix].filter(Boolean);
  return parts.length ? parts.join(" ") : "—";
}

function Dot({ kind }: { kind: "g" | "a" | "r" | "off" }) {
  return <span className={`adm-dot ${kind}`} />;
}

function syncDot(result: string | null): "g" | "a" | "r" {
  if (result === "ok") return "g";
  if (result === "error") return "r";
  return "a";
}

// ------------------------------------------------------------------
// Sign-in (the console's own — same Firebase project, admin dress)

function AdminSignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function emailSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (!auth) return;
    setBusy(true);
    setError("");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch {
      setError("Sign-in failed — check the email and password.");
    } finally {
      setBusy(false);
    }
  }

  async function googleSignIn() {
    if (!auth) return;
    setBusy(true);
    setError("");
    try {
      await signInWithPopup(auth, googleProvider);
    } catch {
      setError("Google sign-in didn't complete.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-center">
      <div className="adm-authcard">
        <div className="adm-brandrow">
          <Mark size={40} />
          <span className="adm-badge">ADMIN</span>
        </div>
        <h1>CareTask Admin</h1>
        <p className="adm-sub">
          The administrators-only console. Sign in with an admin
          account to continue.
        </p>
        {!isFirebaseConfigured && (
          <p className="adm-error">
            Sign-in is not connected yet (Firebase config missing).
          </p>
        )}
        <form onSubmit={emailSignIn}>
          <label>
            Email
            <input
              className="adm-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              className="adm-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          {error && <p className="adm-error">{error}</p>}
          <button className="adm-btn" type="submit" disabled={busy}>
            Sign in
          </button>
          <p className="adm-or">or</p>
          <button
            className="adm-btn ghost"
            type="button"
            onClick={googleSignIn}
            disabled={busy}
          >
            Sign in with Google
          </button>
        </form>
      </div>
    </div>
  );
}

function AdminWall({ user }: { user: User }) {
  return (
    <div className="adm-center">
      <div className="adm-authcard">
        <div className="adm-brandrow">
          <Mark size={40} />
          <span className="adm-badge">ADMIN</span>
        </div>
        <h1>Administrators only</h1>
        <p className="adm-sub">
          You're signed in as <b>{user.email}</b> — that account
          isn't a platform administrator, so the console stays
          closed. If you hold several CareTask logins, sign out
          and come back with the admin one.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (auth) void signOut(auth);
          }}
        >
          <button className="adm-btn" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Overview

function OverviewSection({
  overview,
  onRefresh,
}: {
  overview: AdminOverview;
  onRefresh: () => void;
}) {
  const backup = overview.backups.latest;
  const backupAgeH = backup
    ? (new Date(overview.generated_at).getTime() -
        new Date(backup.mtime).getTime()) /
      3_600_000
    : null;
  const backupStale = backupAgeH !== null && backupAgeH > 26;
  return (
    <>
      <div className="adm-stats">
        <div className="adm-stat">
          <div className="n">{overview.patients.total}</div>
          <div className="l">
            Patients in the registry
            <br />+{overview.patients.created_last_30d} in 30 days
          </div>
        </div>
        <div className="adm-stat">
          <div className="n">{overview.users.active}</div>
          <div className="l">
            Active staff
            <br />
            of {overview.users.total} accounts
          </div>
        </div>
        <div className="adm-stat">
          <div className="n">{overview.episodes.active}</div>
          <div className="l">
            Active episodes
            <br />
            {overview.episodes.on_hold} on hold
          </div>
        </div>
        <div className="adm-stat">
          <div className="n">{overview.appointments.today}</div>
          <div className="l">
            Appointments today
            <br />
            {overview.appointments.next_7d} in the next 7 days
          </div>
        </div>
        <div className="adm-stat">
          <div className="n">{overview.links.active}</div>
          <div className="l">
            Patients on Active lists
            <br />
            {overview.links.hold} on hold · {overview.links.discharged}{" "}
            discharged
          </div>
        </div>
        <div className="adm-stat">
          <div className="n">{overview.invites.pending}</div>
          <div className="l">Pending invites</div>
        </div>
      </div>

      <div className="adm-card">
        <h3>Phone contacts sync</h3>
        {overview.contact_sync.length === 0 ? (
          <p className="adm-note">
            No one has turned on phone sync yet.
          </p>
        ) : (
          <div className="adm-scroll">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Sync</th>
                  <th>Contacts</th>
                  <th>Last sync</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {overview.contact_sync.map((s) => (
                  <tr key={s.user_id}>
                    <td className="adm-email">{s.email}</td>
                    <td>
                      <span
                        className={`adm-chip ${s.enabled ? "on" : "off"}`}
                      >
                        {s.enabled ? "ON" : "OFF"}
                      </span>
                    </td>
                    <td>{s.items}</td>
                    <td>{fmtDT(s.last_sync_at)}</td>
                    <td>
                      <Dot kind={s.enabled ? syncDot(s.last_result) : "off"} />
                      {s.last_result ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="adm-card">
        <h3>Systems</h3>
        <p>
          <Dot kind={backup ? (backupStale ? "a" : "g") : "r"} />
          <b>Database backup</b> —{" "}
          {backup
            ? `${backup.filename} · ${(backup.size_bytes / 1024).toFixed(0)} KB · ${fmtDT(backup.mtime)}`
            : "no backup found"}
          {backupStale &&
            " — over 26 hours old, check the backup timer."}
        </p>
        <p style={{ marginTop: 8 }}>
          <Dot kind={overview.auth_failures_24h === 0 ? "g" : "a"} />
          <b>Sign-in failures (24 h)</b> — {overview.auth_failures_24h}
        </p>
        {overview.recent_errors.length > 0 && (
          <div className="adm-scroll" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Who</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {overview.recent_errors.map((e, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDT(e.at)}</td>
                    <td>
                      <span className="adm-chip warn">{e.event}</span>
                    </td>
                    <td>{e.actor_email}</td>
                    <td className="adm-mono">{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="adm-note">
          As of {fmtDT(overview.generated_at)}.{" "}
          <button className="adm-btn ghost small" onClick={onRefresh}>
            Refresh
          </button>
        </p>
      </div>
    </>
  );
}

// ------------------------------------------------------------------
// Users

function UsersSection({ user }: { user: User }) {
  const [rows, setRows] = useState<AdminUserRow[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [draftRole, setDraftRole] = useState("clinician");
  const [draftAuthorized, setDraftAuthorized] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await listAdminUsers(user));
    } catch {
      setError("Couldn't load the staff list.");
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveEdit(row: AdminUserRow) {
    setBusyId(row.id);
    setError("");
    try {
      await updateStaff(user, row.id, {
        role: draftRole as never,
        authorized: draftAuthorized,
      });
      setEditId(null);
      await load();
    } catch (err) {
      const code = (err as ApiRequestError | null)?.code;
      setError(
        code === "ROLE_REQUIRED" || code === "NO_STAFF_RECORD"
          ? "Your role can't make that change."
          : "Couldn't save that change.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function toggleActive(row: AdminUserRow) {
    setBusyId(row.id);
    setError("");
    try {
      if (row.active) await deactivateStaff(user, row.id);
      else await restoreStaff(user, row.id);
      await load();
    } catch {
      setError(
        row.active
          ? "Couldn't deactivate that account (you can't deactivate your own)."
          : "Couldn't restore that account.",
      );
    } finally {
      setBusyId(null);
    }
  }

  if (!rows) return <p className="adm-note">Loading staff…</p>;
  return (
    <div className="adm-card">
      <h3>Staff accounts — counts only, no patient names</h3>
      {error && <p className="adm-error">{error}</p>}
      <div className="adm-scroll">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>List A / H / D</th>
              <th>Episodes</th>
              <th>Visits</th>
              <th>Phone sync</th>
              <th>Last activity</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>
                  <span className="adm-email">{u.email}</span>
                  <div className="adm-sub2">{fullName(u)}</div>
                </td>
                <td>
                  {editId === u.id ? (
                    <select
                      className="adm-select"
                      value={draftRole}
                      onChange={(e) => setDraftRole(e.target.value)}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span
                      className={`adm-chip ${u.role === "admin" || u.role === "developer" ? "warn" : ""}`}
                    >
                      {u.role}
                    </span>
                  )}
                </td>
                <td>
                  <span className={`adm-chip ${u.active ? "on" : "off"}`}>
                    {u.active ? "active" : "inactive"}
                  </span>
                  {editId === u.id && (
                    <label className="adm-check" style={{ marginTop: 6 }}>
                      <input
                        type="checkbox"
                        checked={draftAuthorized}
                        onChange={(e) =>
                          setDraftAuthorized(e.target.checked)
                        }
                      />
                      authorized provider
                    </label>
                  )}
                  {editId !== u.id && (
                    <div className="adm-sub2">
                      {u.authorized ? "authorized provider" : "not authorized"}
                    </div>
                  )}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <b>{u.links.active}</b> / {u.links.hold} /{" "}
                  {u.links.discharged}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {u.episodes_primary} primary
                  <div className="adm-sub2">
                    {u.episodes_case_manager} case mgr
                  </div>
                </td>
                <td>{u.appointments_total}</td>
                <td>
                  {u.contact_sync ? (
                    <>
                      <Dot
                        kind={
                          u.contact_sync.enabled
                            ? syncDot(u.contact_sync.last_result)
                            : "off"
                        }
                      />
                      {u.contact_sync.enabled
                        ? `on · ${u.contact_sync.items}`
                        : "off"}
                    </>
                  ) : (
                    <span className="adm-sub2">never</span>
                  )}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {fmtDT(u.last_event_at)}
                </td>
                <td>
                  <div className="adm-rowactions">
                    {editId === u.id ? (
                      <>
                        <button
                          className="adm-btn small"
                          disabled={busyId === u.id}
                          onClick={() => void saveEdit(u)}
                        >
                          Save
                        </button>
                        <button
                          className="adm-btn ghost small"
                          onClick={() => setEditId(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="adm-btn ghost small"
                        onClick={() => {
                          setEditId(u.id);
                          setDraftRole(u.role);
                          setDraftAuthorized(u.authorized);
                        }}
                      >
                        Edit
                      </button>
                    )}
                    <button
                      className={
                        u.active
                          ? "adm-btn danger-ghost small"
                          : "adm-btn ghost small"
                      }
                      disabled={busyId === u.id}
                      onClick={() => void toggleActive(u)}
                    >
                      {u.active ? "Deactivate" : "Restore"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Invites (same endpoints as the old Settings card — spec §5)

function InvitesSection({ user }: { user: User }) {
  const [invites, setInvites] = useState<ApiInvite[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("clinician");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setInvites(await listInvites(user));
    } catch {
      setInvites([]);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setLink("");
    setCopied(false);
    try {
      const out = await createInvite(user, {
        email: email.trim().toLowerCase(),
        role,
      });
      // The raw code comes back exactly once. The accept page
      // lives in the clinician app, so the link points at the
      // main app origin, not this admin host.
      setLink(`${MAIN_APP_ORIGIN}${out.accept_path}`);
      setEmail("");
      await load();
    } catch (err) {
      const code = (err as ApiRequestError | null)?.code;
      setError(
        code === "ALREADY_STAFF"
          ? "That person is already on the team."
          : "Couldn't create the invite.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(inv: ApiInvite) {
    setBusy(true);
    setError("");
    try {
      await revokeInvite(user, inv.id);
      await load();
    } catch {
      setError("Couldn't revoke that invite.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-card">
      <h3>Invites — CareTask is invite-only</h3>
      <form className="adm-form-inline" onSubmit={create}>
        <label>
          Email
          <input
            className="adm-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label style={{ flex: "0 1 180px", minWidth: 140 }}>
          Role
          <select
            className="adm-select"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button className="adm-btn" type="submit" disabled={busy}>
          Create invite
        </button>
      </form>
      {error && <p className="adm-error">{error}</p>}
      {link && (
        <div className="adm-linkrow">
          <code>{link}</code>
          <button
            className="adm-btn ghost small"
            onClick={() => {
              void navigator.clipboard
                .writeText(link)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <span className="adm-note">
            Shown once — send it to the invitee now.
          </span>
        </div>
      )}
      <div className="adm-scroll" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(invites ?? []).map((inv) => (
              <tr key={inv.id}>
                <td className="adm-email">{inv.email}</td>
                <td>
                  <span className="adm-chip">{inv.role}</span>
                </td>
                <td>
                  <span
                    className={`adm-chip ${inv.status === "pending" ? "warn" : inv.status === "accepted" ? "on" : "off"}`}
                  >
                    {inv.status}
                  </span>
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {fmtDT(inv.expires_at)}
                </td>
                <td>
                  {inv.status === "pending" && (
                    <button
                      className="adm-btn danger-ghost small"
                      disabled={busy}
                      onClick={() => void revoke(inv)}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {invites !== null && invites.length === 0 && (
          <p className="adm-note">No invites yet.</p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Log (the existing audit-log endpoints — spec §5)

function LogSection({ user }: { user: User }) {
  const [events, setEvents] = useState<ApiEvent[] | null>(null);
  const [chains, setChains] = useState<Record<
    string,
    ChainVerification
  > | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    listEvents(user, { limit: 50 })
      .then((rows) => {
        if (live) setEvents(rows);
      })
      .catch(() => {
        if (live) setError("Couldn't load the log.");
      });
    verifyChain(user)
      .then((out) => {
        if (live) setChains(out);
      })
      .catch(() => {
        if (live) setChains(null);
      });
    return () => {
      live = false;
    };
  }, [user]);

  return (
    <div className="adm-card">
      <h3>Audit log — latest 50 events</h3>
      {chains && (
        <p className="adm-note" style={{ marginTop: 0 }}>
          Hash chain:{" "}
          {Object.entries(chains).map(([table, v]) => (
            <span key={table} style={{ marginRight: 12 }}>
              <Dot kind={v.valid ? "g" : "r"} />
              {table}: {v.valid ? "valid" : "BROKEN"} ({v.checked}/
              {v.total} checked)
            </span>
          ))}
        </p>
      )}
      {error && <p className="adm-error">{error}</p>}
      <div className="adm-scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Actor</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {(events ?? []).map((ev) => (
              <tr key={ev.id}>
                <td style={{ whiteSpace: "nowrap" }}>
                  {fmtDT(ev.created_at)}
                </td>
                <td>
                  <span className="adm-chip">{ev.event}</span>
                </td>
                <td>{ev.actor_email}</td>
                <td className="adm-mono">
                  {JSON.stringify(ev.details ?? {}).slice(0, 90)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {events !== null && events.length === 0 && (
          <p className="adm-note">No events yet.</p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Shell

type Section = "overview" | "users" | "invites" | "log";

export default function AdminApp() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [probe, setProbe] = useState<"loading" | "ok" | "wall" | "error">(
    "loading",
  );
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [section, setSection] = useState<Section>("overview");

  useEffect(() => {
    if (!auth) {
      setUser(null);
      return;
    }
    return onAuthStateChanged(auth, setUser);
  }, []);

  const probeOverview = useCallback(async (u: User) => {
    setProbe("loading");
    try {
      setOverview(await fetchAdminOverview(u));
      setProbe("ok");
    } catch (err) {
      const e = err as ApiRequestError | null;
      if (e?.status === 403) setProbe("wall");
      else setProbe("error");
    }
  }, []);

  useEffect(() => {
    if (user) void probeOverview(user);
  }, [user, probeOverview]);

  if (user === undefined) return <div className="adm-root" />;
  if (!user)
    return (
      <div className="adm-root">
        <AdminSignIn />
      </div>
    );
  if (probe === "wall")
    return (
      <div className="adm-root">
        <AdminWall user={user} />
      </div>
    );
  if (probe === "loading" || !overview)
    return (
      <div className="adm-root">
        <div className="adm-center">
          <p className="adm-note">
            {probe === "error"
              ? "The API didn't answer — check your connection."
              : "Checking your admin access…"}
          </p>
          {probe === "error" && (
            <button
              className="adm-btn"
              style={{ marginLeft: 12 }}
              onClick={() => void probeOverview(user)}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );

  return (
    <div className="adm-root">
      <div className="adm-bar">
        <span className="adm-title">CareTask Admin</span>
        <span className="adm-badge">ADMIN</span>
        <span className="adm-who">
          Signed in as <b>{user.email}</b>
        </span>
        <button
          className="adm-btn ghost small"
          onClick={() => {
            if (auth) void signOut(auth);
          }}
        >
          Sign out
        </button>
      </div>
      <div className="adm-wrap">
        <div className="adm-tabs">
          {(
            [
              ["overview", "Overview"],
              ["users", "Users"],
              ["invites", "Invites"],
              ["log", "Log"],
            ] as Array<[Section, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              className={`adm-tab ${section === key ? "on" : ""}`}
              onClick={() => setSection(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {section === "overview" && (
          <OverviewSection
            overview={overview}
            onRefresh={() => void probeOverview(user)}
          />
        )}
        {section === "users" && <UsersSection user={user} />}
        {section === "invites" && <InvitesSection user={user} />}
        {section === "log" && <LogSection user={user} />}
      </div>
    </div>
  );
}
