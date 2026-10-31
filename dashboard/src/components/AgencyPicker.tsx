import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { XCircle } from "lucide-react";
import { fetchAgencies, type ApiAgency } from "../lib/patientApi";

// Agency picker for the Add / Edit Patient forms (Jake,
// 2026-10-30). A patient can be tagged with their home health
// agency two ways — never both:
//   • pick from the IDPH directory (sets agency_id), or
//   • "not listed" free text (sets agency_name_text) for an
//     agency the directory doesn't carry.
// The directory holds ~595 agencies, so this is a true
// TYPE-AHEAD: no list up front; suggestions appear only as
// you type, matched against display name, legal name/DBA,
// city and license number, capped at 12 rendered rows with
// the total match count shown. Agencies in the patient's own
// city (the form's City field) sort first. Scope DEFAULTS to
// Chicagoland counties (the same metro as the address
// autocomplete's viewbox, expressed as counties since the
// directory is county-keyed) with a "Search all Illinois"
// toggle that widens to the full directory.
export const CHICAGOLAND_COUNTIES = [
  "cook",
  "dupage",
  "kane",
  "lake",
  "mchenry",
  "will",
  "kendall",
  "grundy",
];

const MAX_SUGGESTIONS = 12;

function countyKey(county: string | null): string {
  return (county ?? "")
    .toLowerCase()
    .replace(/\s+county\s*$/, "")
    .trim();
}

export interface AgencySelection {
  agencyId: number | null;
  agencyNameText: string | null;
}

export default function AgencyPicker({
  user,
  apiConnected,
  agencyId,
  agencyNameText,
  onChange,
  patientCity,
  resetKey,
}: {
  user: User;
  apiConnected: boolean;
  agencyId: number | null;
  agencyNameText: string | null;
  onChange: (sel: AgencySelection) => void;
  patientCity: string;
  // Changes when the surrounding form switches patient/record;
  // the picker re-derives its mode from the props at that point
  // (and only then — keystrokes must never flip the mode).
  resetKey: string;
}) {
  const [mode, setMode] = useState<"directory" | "text">(
    agencyId === null && agencyNameText ? "text" : "directory",
  );
  const [agencies, setAgencies] = useState<ApiAgency[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [searchAll, setSearchAll] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against a single tap firing pick() twice (pointerdown +
  // the compatibility click that follows it) — same pattern as
  // AddressAutocomplete.
  const pickGuardRef = useRef<{ key: string; at: number }>({
    key: "",
    at: 0,
  });

  // Follow external resets (Edit form opening on another
  // patient, form reset after an add) — keyed on resetKey only.
  useEffect(() => {
    setMode(agencyId === null && agencyNameText ? "text" : "directory");
    setQuery("");
    setOpen(false);
    setSearchAll(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    if (!apiConnected || agencies !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchAgencies(user, { active: true });
        if (!cancelled) setAgencies(data);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, apiConnected, agencies]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // fetchAgencies normalizes id to a number (pg sends BIGINT as a
  // string); compare through Number() anyway as a backstop, so a
  // string id can never again strand the chip on "Agency #<id>".
  const selectedAgency =
    agencyId !== null
      ? (agencies ?? []).find((a) => Number(a.id) === Number(agencyId)) ??
        null
      : null;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !agencies) return { total: 0, rows: [] as ApiAgency[] };
    const pool = searchAll
      ? agencies
      : agencies.filter((a) =>
          CHICAGOLAND_COUNTIES.includes(countyKey(a.county)),
        );
    const cityKey = patientCity.trim().toLowerCase();
    const hit = pool.filter((a) =>
      [a.display_name, a.name, a.dba ?? "", a.city ?? "", a.license_number]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
    hit.sort((a, b) => {
      const aCity = cityKey && (a.city ?? "").toLowerCase() === cityKey ? 0 : 1;
      const bCity = cityKey && (b.city ?? "").toLowerCase() === cityKey ? 0 : 1;
      if (aCity !== bCity) return aCity - bCity;
      return a.display_name.localeCompare(b.display_name);
    });
    return { total: hit.length, rows: hit.slice(0, MAX_SUGGESTIONS) };
  }, [query, agencies, searchAll, patientCity]);

  function pick(a: ApiAgency) {
    const key = String(a.id);
    const now = Date.now();
    if (
      pickGuardRef.current.key === key &&
      now - pickGuardRef.current.at < 700
    )
      return;
    pickGuardRef.current = { key, at: now };
    onChange({ agencyId: a.id, agencyNameText: null });
    setQuery("");
    setOpen(false);
  }

  if (!apiConnected) {
    return (
      <div className="agency-picker">
        <input
          type="text"
          value={agencyNameText ?? ""}
          onChange={(e) =>
            onChange({ agencyId: null, agencyNameText: e.target.value })
          }
          placeholder="Agency name (directory unavailable — type it)"
          aria-label="Agency name"
        />
        <p className="agency-picker-note">
          Agency directory unavailable — you can type the name, or open
          CareTask at marcinnotech-app.pages.dev for the searchable
          directory.
        </p>
      </div>
    );
  }

  if (mode === "text") {
    return (
      <div className="agency-picker">
        <input
          type="text"
          value={agencyNameText ?? ""}
          onChange={(e) =>
            onChange({ agencyId: null, agencyNameText: e.target.value })
          }
          placeholder="Type the agency name"
          aria-label="Agency name (not in directory)"
        />
        {loadError && (
          <p className="agency-picker-note">
            Agency directory unavailable — you can type the name, or
            open CareTask at marcinnotech-app.pages.dev for the
            searchable directory.
          </p>
        )}
        <button
          type="button"
          className="linklike agency-picker-toggle"
          onClick={() => {
            setMode("directory");
            onChange({ agencyId: null, agencyNameText: null });
          }}
        >
          Pick from the directory instead
        </button>
      </div>
    );
  }

  return (
    <div className="agency-picker" ref={wrapRef}>
      {agencyId !== null ? (
        <div className="agency-picker-selected">
          <span>
            {selectedAgency
              ? selectedAgency.display_name
              : `Agency #${agencyId}`}
            {selectedAgency?.city ? (
              <span className="card-meta"> · {selectedAgency.city}</span>
            ) : null}
          </span>
          <button
            type="button"
            className="agency-search-clear"
            aria-label="Clear agency"
            title="Clear agency"
            onClick={() => {
              onChange({ agencyId: null, agencyNameText: null });
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            <XCircle size={17} />
          </button>
        </div>
      ) : (
        <>
          <div className="agency-picker-field">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                setHighlight(0);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : -1;
                  setHighlight((h) =>
                    Math.min(
                      Math.max(h + d, 0),
                      Math.max(matches.rows.length - 1, 0),
                    ),
                  );
                } else if (
                  e.key === "Enter" &&
                  open &&
                  matches.rows[highlight]
                ) {
                  e.preventDefault();
                  pick(matches.rows[highlight]);
                } else if (e.key === "Escape") {
                  setOpen(false);
                } else if (
                  e.key === "Tab" &&
                  open &&
                  query.trim() &&
                  matches.rows.length > 0
                ) {
                  e.preventDefault();
                  pick(matches.rows[highlight] ?? matches.rows[0]);
                }
              }}
              placeholder="Start typing an agency name, city, or license #"
              aria-label="Agency (search the directory)"
            />
            {open && query.trim() && (
              <div className="addr-drop" role="listbox">
                {agencies === null && !loadError && (
                  <div className="addr-item addr-muted">
                    Loading directory…
                  </div>
                )}
                {loadError && (
                  <div className="addr-item addr-muted">
                    Directory unavailable — use “Not listed” below.
                  </div>
                )}
                {agencies !== null && matches.total === 0 && (
                  <div className="addr-item addr-muted">
                    No matches {searchAll ? "" : "in Chicagoland"} — keep
                    typing{searchAll ? "" : " or search all Illinois"}.
                  </div>
                )}
                {matches.rows.map((a, i) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`addr-item${i === highlight ? " addr-hl" : ""}`}
                    onMouseEnter={() => setHighlight(i)}
                    onPointerDown={(e) => {
                      // Pointer events cover touch as well as mouse —
                      // mouse-only handlers miss taps on some phones
                      // (same fix as AddressAutocomplete, deploy-12).
                      e.preventDefault();
                      pick(a);
                    }}
                    onClick={() => {
                      // Fallback for browsers that don't deliver
                      // pointerdown; the guard in pick() dedupes the
                      // double-fire when both handlers run.
                      pick(a);
                    }}
                  >
                    <strong>{a.display_name}</strong>{" "}
                    <span className="card-meta">
                      · {a.city ?? "—"}
                      {patientCity.trim() &&
                      (a.city ?? "").toLowerCase() ===
                        patientCity.trim().toLowerCase()
                        ? " · patient's city"
                        : ""}
                    </span>
                  </button>
                ))}
                {matches.total > MAX_SUGGESTIONS && (
                  <div className="addr-item addr-muted">
                    Showing {MAX_SUGGESTIONS} of {matches.total} matches —
                    keep typing to narrow
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="agency-picker-toggles">
            <button
              type="button"
              className="linklike agency-picker-toggle"
              onClick={() => setSearchAll((v) => !v)}
            >
              {searchAll
                ? "Searching all Illinois — limit to Chicagoland"
                : "Searching Chicagoland only — search all Illinois"}
            </button>
            <button
              type="button"
              className="linklike agency-picker-toggle"
              onClick={() => {
                setMode("text");
                onChange({ agencyId: null, agencyNameText: "" });
              }}
            >
              Not listed — type the agency name
            </button>
          </div>
        </>
      )}
    </div>
  );
}
