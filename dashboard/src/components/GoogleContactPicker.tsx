// Picker for the Google Contacts import prototype. Two modes:
// single (the Add Patient form — one pick pre-fills the form) and
// multi (the Clinician tab — checkbox several contacts, import them
// as staff). The picker only FETCHES and lets the user choose; what
// a pick creates is the caller's business (patient form prefill, or
// PIN-gated staff creation).
//
// Source choice: connect the user's own Google account (read-only
// scope, token in memory only) when an OAuth client is configured,
// or run the identical flow on fictional SAMPLE contacts — the
// sample path is a first-class citizen so the prototype can be
// evaluated before any Google Cloud setup exists.
import { useMemo, useState } from "react";
import {
  fetchGoogleContacts,
  isGoogleImportConfigured,
  requestContactsAccessToken,
  sampleCandidates,
  type ContactCandidate,
} from "../lib/googleContacts";

interface Props {
  mode: "single" | "multi";
  onPick: (picked: ContactCandidate[]) => void;
  onClose: () => void;
}

type Phase = "source" | "loading" | "list" | "error";

export default function GoogleContactPicker({ mode, onPick, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("source");
  const [errorMsg, setErrorMsg] = useState("");
  const [candidates, setCandidates] = useState<ContactCandidate[]>([]);
  const [fromSample, setFromSample] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const configured = isGoogleImportConfigured();

  async function connectGoogle() {
    setPhase("loading");
    setErrorMsg("");
    try {
      const token = await requestContactsAccessToken();
      const rows = await fetchGoogleContacts(token);
      setCandidates(rows);
      setFromSample(false);
      setSelected(new Set());
      setPhase("list");
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Couldn't fetch contacts.",
      );
      setPhase("error");
    }
  }

  function useSamples() {
    setCandidates(sampleCandidates());
    setFromSample(true);
    setSelected(new Set());
    setPhase("list");
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) =>
      [c.displayName, c.email, c.phoneCell, c.phoneHome, c.city]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [candidates, query]);

  function toggle(resourceName: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(resourceName)) next.delete(resourceName);
      else next.add(resourceName);
      return next;
    });
  }

  function metaLine(c: ContactCandidate): string {
    return [c.email, c.phoneCell || c.phoneHome, c.city]
      .filter(Boolean)
      .join(" · ");
  }

  return (
    <div className="contact-picker">
      <div className="card-top">
        <strong>Import from Google Contacts</strong>
        <button className="btn btn-secondary" type="button" onClick={onClose}>
          Close
        </button>
      </div>

      {phase === "source" && (
        <>
          <p className="section-note">
            Contacts come from the Google account you connect — read-only,
            fetched once for this import, nothing syncs or stays behind.
            {mode === "single"
              ? " Picking a contact fills in the form; nothing is saved until you save the patient."
              : " Picked contacts become staff records — a manager PIN confirms the import."}
          </p>
          <div className="profile-actions">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void connectGoogle()}
              disabled={!configured}
            >
              Connect Google Contacts
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={useSamples}
            >
              Use sample contacts
            </button>
          </div>
          {!configured && (
            <p className="section-note">
              Google sign-in isn't configured for this dashboard yet, so
              Connect is disabled — the sample contacts run the full
              import flow.
            </p>
          )}
        </>
      )}

      {phase === "loading" && (
        <p className="section-note">Fetching your contacts…</p>
      )}

      {phase === "error" && (
        <>
          <p className="pin-error">{errorMsg}</p>
          <div className="profile-actions">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setPhase("source")}
            >
              Back
            </button>
          </div>
        </>
      )}

      {phase === "list" && (
        <>
          <p className="section-note">
            {fromSample ? "Sample contacts (fictional). " : ""}
            {visible.length} of {candidates.length} contacts
            {mode === "multi" ? ` · ${selected.size} selected` : ""}.
          </p>
          <input
            className="contact-picker-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, phone, city"
          />
          <ul className="patient-list contact-picker-list">
            {visible.map((c) => (
              <li key={c.resourceName} className="patient-row">
                {mode === "multi" ? (
                  <label className="contact-picker-row">
                    <input
                      type="checkbox"
                      checked={selected.has(c.resourceName)}
                      onChange={() => toggle(c.resourceName)}
                    />
                    <span className="patient-name">{c.displayName}</span>
                    <span className="patient-meta">{metaLine(c)}</span>
                  </label>
                ) : (
                  <button
                    type="button"
                    className="contact-picker-row contact-picker-pick"
                    onClick={() => onPick([c])}
                  >
                    <span className="patient-name">{c.displayName}</span>
                    <span className="patient-meta">{metaLine(c)}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
          {visible.length === 0 && (
            <p className="section-note">No contacts match that search.</p>
          )}
          {mode === "multi" && (
            <div className="profile-actions">
              <button
                className="btn btn-primary"
                type="button"
                disabled={selected.size === 0}
                onClick={() =>
                  onPick(
                    candidates.filter((c) => selected.has(c.resourceName)),
                  )
                }
              >
                Import {selected.size} selected
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={onClose}
              >
                Cancel
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
