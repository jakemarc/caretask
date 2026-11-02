import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { Search, StickyNote, XCircle } from "lucide-react";
import {
  fetchAgencies,
  isRoleRejection,
  updateAgency,
  type AgencyServiceKey,
  type ApiAgency,
} from "../lib/patientApi";
import { isManagerRole, useMyStaff } from "../lib/useMyRole";
import {
  callingHref, telHref } from "../lib/phone";

// Agency tab: the searchable statewide IDPH directory. Data
// comes from the CareTask API (agencies table, synced from the
// IDPH Home Health Agency Directory). Syncing lives in
// Settings → Agency directory, and there is deliberately no
// single "our agency" — Jake works for different agencies
// (2026-10-30). When the API is unreachable the tab says so —
// the directory is never faked in the browser.
//
// Names: display_name (computed by the API — local short_name,
// else the DBA embedded in the IDPH name, else the first two
// words). The directory TABLE shows only the display name in
// the Agency column (Jake, 2026-10-30 — no legal name or street
// beneath it); the profile card shows the full legal name.
//
// Tapping an agency name opens its profile card (Jake,
// 2026-10-30): every field the API carries for that agency,
// plus the local-details editor (short name + notes, role-gated
// to managers/admins) that used to live in a table row.

// CMS service lines (Jake, 2026-10-30): the six disciplines the
// CMS dataset reports Yes/No for. `field` is the ApiAgency
// column; the filter chips and the profile card share this list.
const SERVICES: {
  key: AgencyServiceKey;
  filterLabel: string;
  // Short label for the filter chips on phones (Jake,
  // 2026-10-31): chips spell the service out on desktop
  // (fullLabel) and abbreviate at the mobile breakpoint.
  shortLabel: string;
  fullLabel: string;
  field:
    | "offers_nursing"
    | "offers_pt"
    | "offers_ot"
    | "offers_speech"
    | "offers_msw"
    | "offers_hha";
}[] = [
  { key: "nursing", filterLabel: "Nursing", shortLabel: "SN", fullLabel: "Nursing care", field: "offers_nursing" },
  { key: "pt", filterLabel: "PT", shortLabel: "PT", fullLabel: "Physical therapy", field: "offers_pt" },
  { key: "ot", filterLabel: "OT", shortLabel: "OT", fullLabel: "Occupational therapy", field: "offers_ot" },
  { key: "speech", filterLabel: "Speech", shortLabel: "ST", fullLabel: "Speech pathology", field: "offers_speech" },
  { key: "msw", filterLabel: "Social Work", shortLabel: "MSW", fullLabel: "Medical social services", field: "offers_msw" },
  { key: "hha", filterLabel: "Home Health Aide", shortLabel: "HHA", fullLabel: "Home health aide", field: "offers_hha" },
];

// Postgres NUMERIC arrives as a string; normalize once here.
// null = CMS does not rate this agency (or no CMS match).
function ratingValue(a: ApiAgency): number | null {
  if (a.star_rating === null || a.star_rating === undefined) return null;
  const n =
    typeof a.star_rating === "number"
      ? a.star_rating
      : parseFloat(String(a.star_rating));
  return Number.isFinite(n) ? n : null;
}

function fmtRating(a: ApiAgency): string {
  const n = ratingValue(a);
  if (n === null) return "—";
  return `★ ${Number.isInteger(n) ? String(n) : n.toFixed(1)}`;
}

function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v.length <= 10 ? `${v}T12:00:00` : v);
  return Number.isNaN(d.getTime()) ? v.slice(0, 10) : d.toLocaleDateString();
}

function fmtDateTime(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
}

function expirySoon(v: string | null): boolean {
  if (!v) return false;
  const d = new Date(v.length <= 10 ? `${v}T12:00:00` : v);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() - Date.now() < 90 * 24 * 3600 * 1000;
}

export default function AgencyView({
  user,
  apiConnected,
}: {
  user: User;
  apiConnected: boolean;
}) {
  const [rows, setRows] = useState<ApiAgency[]>([]);
  // Directory table shows Agency / City / Rating / Phone
  // (Jake, 2026-10-30) and sorts client-side — fetchAgencies
  // loads the whole directory (limit 1000), so the sort covers
  // every row. Filtering (search, services, min rating,
  // active) goes through the API, same pattern as the search
  // box — the table only ever sorts what the API returned.
  const [sort, setSort] = useState<{
    key: "name" | "city" | "phone" | "rating";
    dir: 1 | -1;
  }>({ key: "name", dir: 1 });
  function toggleSort(key: "name" | "city" | "phone" | "rating") {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 1 ? -1 : 1 }
        : // Rating reads best-first by default (Jake, 2026-10-30).
          { key, dir: key === "rating" ? -1 : 1 },
    );
  }
  const sortedRows = [...rows].sort((a, b) => {
    if (sort.key === "rating") {
      const av = ratingValue(a);
      const bv = ratingValue(b);
      // Unrated always last, in BOTH directions.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * sort.dir;
    }
    const av =
      sort.key === "name" ? a.display_name : (a[sort.key] ?? "");
    const bv =
      sort.key === "name" ? b.display_name : (b[sort.key] ?? "");
    return av.localeCompare(bv) * sort.dir;
  });
  const [query, setQuery] = useState("");
  const [serviceFilter, setServiceFilter] = useState<AgencyServiceKey[]>([]);
  const [minRating, setMinRating] = useState<number | undefined>(undefined);
  function toggleService(key: AgencyServiceKey) {
    setServiceFilter((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const [editing, setEditing] = useState(false);
  const [shortNameDraft, setShortNameDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");

  const me = useMyStaff(user);
  const isManager = isManagerRole(me);

  useEffect(() => {
    if (!apiConnected) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const data = await fetchAgencies(user, {
            q: query.trim() || undefined,
            active: showInactive ? undefined : true,
            service: serviceFilter.length ? serviceFilter : undefined,
            minRating,
          });
          if (cancelled) return;
          setRows(data);
          setListError(null);
        } catch {
          if (cancelled) return;
          setListError(
            "Could not load the agency directory from the API. Check the connection and try again.",
          );
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [user, apiConnected, query, showInactive, serviceFilter, minRating]);

  function startEdit(a: ApiAgency) {
    setEditing(true);
    setShortNameDraft(a.short_name ?? "");
    setNotesDraft(a.notes ?? "");
    setActionError(null);
  }

  async function saveEdit(a: ApiAgency) {
    setActionError(null);
    setBusyId(a.id);
    try {
      const updated = await updateAgency(user, a.id, {
        short_name: shortNameDraft.trim() === "" ? null : shortNameDraft,
        notes: notesDraft.trim() === "" ? null : notesDraft,
      });
      setEditing(false);
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setActionError(
        isRoleRejection(err)
          ? "Editing agency details needs a manager or admin role."
          : err instanceof Error
            ? err.message
            : "The change could not be saved.",
      );
    } finally {
      setBusyId(null);
    }
  }

  if (selected) {
    const a = selected;
    const address = [
      a.street,
      [a.city, a.state].filter(Boolean).join(", "),
      a.postal_code,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="card-list">
        <article className="card">
          <div className="card-top">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setSelectedId(null);
                setEditing(false);
              }}
            >
              ← Agency directory
            </button>
            <span className="kind-badge">
              {a.active ? "Active" : "Inactive"}
            </span>
          </div>
          <h3 className="agency-display-name">{a.display_name}</h3>
          {a.display_name !== a.name && (
            <p className="card-meta">{a.name}</p>
          )}
          <p className="agency-rating-line">
            {ratingValue(a) !== null ? (
              <>
                <span className="agency-rating-star">{fmtRating(a)}</span>
                {" — CMS quality of patient care rating"}
              </>
            ) : (
              "Not rated by CMS"
            )}
          </p>
          {actionError && (
            <p className="danger-note" role="alert">
              {actionError}
            </p>
          )}
          <div className="agency-profile-grid">
            {a.dba && (
              <div>
                <span className="agency-field-label">DBA</span>
                {a.dba}
              </div>
            )}
            <div>
              <span className="agency-field-label">Address</span>
              {address || "—"}
            </div>
            <div>
              <span className="agency-field-label">County</span>
              {a.county ?? "—"}
            </div>
            <div>
              <span className="agency-field-label">Phone</span>
              {a.phone && telHref(a.phone) ? (
                <a href={callingHref(a.phone) ?? "#"}>{a.phone}</a>
              ) : (
                "—"
              )}
            </div>
            <div>
              <span className="agency-field-label">Admin contact</span>
              {a.admin_contact_name ?? "—"}
            </div>
            <div>
              <span className="agency-field-label">License #</span>
              {a.license_number}
            </div>
            <div>
              <span className="agency-field-label">License expires</span>
              <span
                className={
                  expirySoon(a.license_expiration_date)
                    ? "agency-expiry-warn"
                    : undefined
                }
              >
                {fmtDate(a.license_expiration_date)}
              </span>
            </div>
            {a.ccn && (
              <div>
                <span className="agency-field-label">CCN (CMS)</span>
                {a.ccn}
              </div>
            )}
            {a.cms_ownership && (
              <div>
                <span className="agency-field-label">Ownership (CMS)</span>
                {a.cms_ownership}
              </div>
            )}
            {a.cms_cert_date && (
              <div>
                <span className="agency-field-label">
                  CMS certification
                </span>
                {fmtDate(a.cms_cert_date)}
              </div>
            )}
            <div>
              <span className="agency-field-label">Source</span>
              IDPH Home Health Agency Directory
              {a.cms_matched_at ? " · CMS Provider Data" : ""}
            </div>
            <div>
              <span className="agency-field-label">Last synced</span>
              {fmtDateTime(a.last_synced_at)}
            </div>
          </div>
          {a.cms_matched_at ? (
            <>
              <div className="card-top">
                <strong>Services (CMS)</strong>
              </div>
              <div className="agency-service-list">
                {SERVICES.map((s) => (
                  <span
                    key={s.key}
                    className={`chip${a[s.field] ? " active" : ""}`}
                  >
                    {a[s.field] ? "✓ " : "— "}
                    {s.fullLabel}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="card-meta">
              Services (CMS): no CMS match for this agency yet, so
              service lines and the star rating are unavailable.
            </p>
          )}
          <div className="card-top">
            <strong>Local details</strong>
            {!editing && isManager && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => startEdit(a)}
              >
                Edit local details
              </button>
            )}
          </div>
          {editing ? (
            <div className="agency-edit-grid">
              <label>
                Short name (shown instead of the legal name; blank =
                automatic)
                <input
                  type="text"
                  value={shortNameDraft}
                  onChange={(e) => setShortNameDraft(e.target.value)}
                  placeholder={a.dba ?? "e.g. BrightStar Care"}
                />
              </label>
              <label>
                Local notes (never sent to IDPH, never overwritten by
                a sync)
                <textarea
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  rows={2}
                />
              </label>
              <div className="flag-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busyId === a.id}
                  onClick={() => void saveEdit(a)}
                >
                  Save local details
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="card-meta">
                Short name: {a.short_name ?? "— (automatic)"}
              </p>
              <p className="card-meta">
                Notes: {a.notes ?? "—"}
              </p>
            </>
          )}
        </article>
      </div>
    );
  }

  return (
    <div className="card-list">
      {/* ---------------- Directory ---------------- */}
      <article className="card">
        <div className="card-top">
          <strong>Agency directory</strong>
          <span className="kind-badge">{rows.length} shown</span>
        </div>
        {!apiConnected ? (
          <p className="card-meta">
            The directory lives in the CareTask API, which is not
            connected right now (demo mode).
          </p>
        ) : (
          <>
            <div className="agency-search-row">
              <label className="agency-search">
                <Search size={15} />
                <input
                  ref={searchInputRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by agency name, DBA, city, or license #"
                  aria-label="Search agencies"
                />
                {query && (
                  <button
                    type="button"
                    className="agency-search-clear"
                    aria-label="Clear search"
                    title="Clear search"
                    onClick={(e) => {
                      e.preventDefault();
                      setQuery("");
                      searchInputRef.current?.focus();
                    }}
                  >
                    <XCircle size={17} />
                  </button>
                )}
              </label>
              <label className="agency-inactive-toggle">
                <input
                  type="checkbox"
                  checked={showInactive}
                  onChange={(e) => setShowInactive(e.target.checked)}
                />
                Show inactive
              </label>
            </div>
            <div className="agency-filter-row">
              <div
                className="agency-service-chips"
                role="group"
                aria-label="Filter by service line (CMS)"
              >
                <button
                  type="button"
                  className={`chip${serviceFilter.length === 0 ? " active" : ""}`}
                  aria-label="All services"
                  onClick={() => setServiceFilter([])}
                >
                  <span className="chip-label-full">All services</span>
                  <span className="chip-label-short">All</span>
                </button>
                {SERVICES.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    className={`chip${serviceFilter.includes(s.key) ? " active" : ""}`}
                    aria-label={s.fullLabel}
                    aria-pressed={serviceFilter.includes(s.key)}
                    onClick={() => toggleService(s.key)}
                  >
                    <span className="chip-label-full">{s.fullLabel}</span>
                    <span className="chip-label-short">{s.shortLabel}</span>
                  </button>
                ))}
              </div>
              <label className="agency-rating-filter">
                Rating
                <select
                  value={minRating === undefined ? "" : String(minRating)}
                  onChange={(e) =>
                    setMinRating(
                      e.target.value === ""
                        ? undefined
                        : Number(e.target.value),
                    )
                  }
                  aria-label="Minimum CMS star rating"
                >
                  <option value="">Any</option>
                  <option value="3">3+</option>
                  <option value="4">4+</option>
                  <option value="4.5">4.5+</option>
                </select>
              </label>
            </div>
            {listError ? (
              <p className="danger-note" role="alert">
                {listError}
              </p>
            ) : rows.length === 0 ? (
              <p className="card-meta">
                No agencies match the current search and filters.
                If the directory has never been synced on this
                server, run a sync from Settings → Agency
                directory.
              </p>
            ) : (
              <div className="agency-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>
                        <button
                          type="button"
                          className="th-sort"
                          onClick={() => toggleSort("name")}
                        >
                          Agency
                          {sort.key === "name"
                            ? sort.dir === 1
                              ? " ↑"
                              : " ↓"
                            : ""}
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="th-sort"
                          onClick={() => toggleSort("city")}
                        >
                          City
                          {sort.key === "city"
                            ? sort.dir === 1
                              ? " ↑"
                              : " ↓"
                            : ""}
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="th-sort"
                          onClick={() => toggleSort("rating")}
                        >
                          Rating
                          {sort.key === "rating"
                            ? sort.dir === 1
                              ? " ↑"
                              : " ↓"
                            : ""}
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="th-sort"
                          onClick={() => toggleSort("phone")}
                        >
                          Phone
                          {sort.key === "phone"
                            ? sort.dir === 1
                              ? " ↑"
                              : " ↓"
                            : ""}
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <button
                            type="button"
                            className="linklike"
                            onClick={() => {
                              setSelectedId(a.id);
                              setEditing(false);
                              setActionError(null);
                            }}
                          >
                            <strong>{a.display_name}</strong>
                          </button>
                          {a.notes && (
                            <>
                              {" "}
                              <span className="kind-badge">
                                <StickyNote size={11} /> Notes
                              </span>
                            </>
                          )}
                        </td>
                        <td>{a.city ?? "—"}</td>
                        <td>{fmtRating(a)}</td>
                        <td>
                          {a.phone && telHref(a.phone) ? (
                            <a
                              className="linklike"
                              href={callingHref(a.phone) ?? "#"}
                            >
                              {a.phone}
                            </a>
                          ) : (
                            (a.phone ?? "—")
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </article>
    </div>
  );
}
