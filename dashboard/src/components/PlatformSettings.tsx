// Settings cards for the multi-user platform (2026-11-03):
// My Agencies (everyone) and Invites (platform admins).
// Membership in an agency is what lets a clinician open episodes,
// join episode teams, and take coverage visits there. Invites are
// the only way in — sign-up is invite-only by design.
import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  addMyAgency,
  createInvite,
  fetchAgencies,
  fetchMyAgencies,
  listInvites,
  removeMyAgency,
  revokeInvite,
  type ApiAgency,
  type ApiInvite,
  type ApiMyAgency,
  type ApiRequestError,
} from "../lib/patientApi";
import { useMyStaff } from "../lib/useMyRole";

interface Props {
  user: User;
  apiConnected: boolean;
}

const ROLE_OPTIONS = [
  "clinician",
  "manager",
  "front_office",
  "billing",
  "support",
  "admin",
  "developer",
] as const;

export function MyAgenciesCard({ user, apiConnected }: Props) {
  const [mine, setMine] = useState<ApiMyAgency[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ApiAgency[]>([]);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!apiConnected) return;
    let live = true;
    fetchMyAgencies(user)
      .then((rows) => {
        if (live) setMine(rows);
      })
      .catch(() => {
        if (live) setMine([]);
      });
    return () => {
      live = false;
    };
  }, [user, apiConnected]);

  if (!apiConnected) {
    return (
      <article className="card">
        <strong>My agencies</strong>
        <p>
          Agency membership needs the API — it can't load while the
          API is unreachable.
        </p>
      </article>
    );
  }

  async function search() {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    setError("");
    try {
      const rows = await fetchAgencies(user, { q, active: true });
      setResults(rows.slice(0, 8));
    } catch {
      setError("Couldn't search the agency directory.");
    } finally {
      setSearching(false);
    }
  }

  async function add(agency: ApiAgency) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await addMyAgency(user, agency.id);
      setMine(await fetchMyAgencies(user));
      setNotice(`Added ${agency.display_name} to your agencies.`);
    } catch {
      setError("Couldn't add that agency.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(agency: ApiMyAgency) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await removeMyAgency(user, agency.id);
      setMine(await fetchMyAgencies(user));
      setNotice(`Removed ${agency.display_name}.`);
    } catch (err) {
      const code = (err as ApiRequestError | null)?.code;
      setError(
        code === "PRIMARY_ON_ACTIVE_EPISODE"
          ? "You're the primary on an active episode at this agency — discharge it or hand the primary role to a teammate first."
          : "Couldn't remove that agency.",
      );
    } finally {
      setBusy(false);
    }
  }

  const myIds = new Set((mine ?? []).map((a) => a.id));

  return (
    <article className="card">
      <div className="card-top">
        <strong>My agencies</strong>
      </div>
      <p>
        The agencies you work for. You can open episodes, join
        episode teams, and cover visits only at your agencies.
      </p>
      {mine === null ? (
        <p className="section-note">Loading…</p>
      ) : mine.length === 0 ? (
        <p className="section-note">
          You're not a member of any agency yet — add one below.
        </p>
      ) : (
        <ul className="schedule-list">
          {mine.map((a) => (
            <li key={a.id} className="schedule-item">
              <span>
                <strong>{a.display_name}</strong>
                {[a.city, a.state].filter(Boolean).length > 0 &&
                  ` — ${[a.city, a.state].filter(Boolean).join(", ")}`}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void remove(a)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flag-actions">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void search();
            }
          }}
          placeholder="Search the agency directory…"
          aria-label="Search the agency directory"
        />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={searching || query.trim().length < 2}
          onClick={() => void search()}
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </div>
      {results.length > 0 && (
        <ul className="schedule-list">
          {results.map((a) => (
            <li key={a.id} className="schedule-item">
              <span>
                <strong>{a.display_name}</strong>
                {[a.city, a.state].filter(Boolean).length > 0 &&
                  ` — ${[a.city, a.state].filter(Boolean).join(", ")}`}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || myIds.has(a.id)}
                onClick={() => void add(a)}
              >
                {myIds.has(a.id) ? "Added" : "Add"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="section-note">{notice}</p>}
      {error && <p className="pin-error">{error}</p>}
    </article>
  );
}

export function InvitesCard({ user, apiConnected }: Props) {
  const me = useMyStaff(user);
  const isPlatformAdmin =
    !!me && me.active && (me.role === "admin" || me.role === "developer");
  const [invites, setInvites] = useState<ApiInvite[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("clinician");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!apiConnected || !isPlatformAdmin) return;
    let live = true;
    listInvites(user)
      .then((rows) => {
        if (live) setInvites(rows);
      })
      .catch(() => {
        if (live) setInvites([]);
      });
    return () => {
      live = false;
    };
  }, [user, apiConnected, isPlatformAdmin]);

  // Invite management is a platform-admin act; other roles never
  // see the card at all.
  if (!isPlatformAdmin) return null;

  if (!apiConnected) {
    return (
      <article className="card">
        <strong>Invites</strong>
        <p>Invites need the API — it can't run while the API is unreachable.</p>
      </article>
    );
  }

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
      // The raw code is returned exactly once — build the link now.
      setLink(`${window.location.origin}${out.accept_path}`);
      setEmail("");
      setInvites(await listInvites(user));
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
      setInvites(await listInvites(user));
    } catch {
      setError("Couldn't revoke that invite.");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className="card">
      <div className="card-top">
        <strong>Invites</strong>
      </div>
      <p>
        CareTask is invite-only. Invite a clinician by email; they
        follow the link, create their sign-in, and land in a blank
        workspace of their own. Invites expire in 7 days.
      </p>
      <form onSubmit={create}>
        <div className="flag-actions">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            aria-label="Email to invite"
            required
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            aria-label="Role for the invite"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !email.trim()}
          >
            Create invite
          </button>
        </div>
      </form>
      {link && (
        <div className="csv-import-panel">
          <p className="section-note">
            Send this link to the person you invited — it's shown
            only once:
          </p>
          <div className="flag-actions">
            <input
              type="text"
              readOnly
              value={link}
              aria-label="Invite link"
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void copyLink()}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="pin-error">{error}</p>}
      {invites === null ? (
        <p className="section-note">Loading…</p>
      ) : invites.length === 0 ? (
        <p className="section-note">No invites yet.</p>
      ) : (
        <ul className="schedule-list">
          {invites.map((inv) => (
            <li key={inv.id} className="schedule-item">
              <span>
                <strong>{inv.email}</strong> — {inv.role} · {inv.status}
                {inv.status === "pending" &&
                  ` · expires ${new Date(inv.expires_at).toLocaleDateString()}`}
              </span>
              {inv.status === "pending" && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void revoke(inv)}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
