// Settings → Database utilities: CSV import of Google Contacts
// exports (the CSV form of Google People contacts) into the
// patients and users (staff) tables. Built 2026-10-30.
//
// Shape of the feature:
// - Two buttons, "Import patients" and "Import staff", each
//   opening its own flow inside this card.
// - The file is parsed IN THE BROWSER (lib/googleCsv.ts) into the
//   same ContactCandidate shape the Google Contacts import uses.
//   The raw file is never uploaded anywhere — only rows the user
//   confirms are sent, one by one, through the existing API
//   creates (createPatient / createStaff).
// - Preview before anything saves: every row shows a status
//   (Ready / Missing required / Possible duplicate / Already on
//   the team / Duplicate in file); Ready rows start checked,
//   problem rows unchecked and locked. Nothing saves until the
//   Import button is pressed.
// - Staff import is manager-PIN gated FIRST (verified against the
//   API, PIN held in memory only while this card is open), the
//   same pattern as the Clinician-tab staff import and Settings →
//   Visit categories. Imported staff start as unauthorized
//   clinicians.
// - Fails closed: with no API connection the card shows the
//   not-connected notice and no import is possible.
import { useRef, useState } from "react";
import type { User } from "firebase/auth";
import type { PersonUnderCare } from "../lib/demoData";
import {
  missingPatientFields,
  missingStaffFields,
  parseGoogleContactsCsv,
  type CsvContact,
} from "../lib/googleCsv";
import {
  createPatient,
  createStaff,
  isPinRejection,
  listPatients,
  listUsers,
  verifyManagerPin,
  type ApiUser,
  type NewApiPatient,
  type StaffInput,
} from "../lib/patientApi";

interface Props {
  user: User;
  apiConnected: boolean;
  // Created patients are handed up so the dashboard's patient
  // list (loaded once at sign-in) includes them without a reload.
  onPatientsImported?: (created: PersonUnderCare[]) => void;
}

type Target = "patients" | "staff";
type RowStatus = "ready" | "missing" | "duplicate" | "team" | "infile";

interface PreviewRow {
  key: string;
  contact: CsvContact;
  status: RowStatus;
  label: string;
  detail: string;
  checked: boolean;
  result?: string;
}

interface ImportSummary {
  imported: number;
  skipped: number;
  failed: number;
  failures: { name: string; reason: string }[];
}

const blankToNull = (s: string): string | null => {
  const t = s.trim();
  return t ? t : null;
};

function buildPatientInput(contact: CsvContact): NewApiPatient {
  const c = contact.candidate;
  return {
    title: blankToNull(contact.title),
    fname: c.fname.trim(),
    mname: blankToNull(c.mname),
    lname: c.lname.trim(),
    suffix: blankToNull(contact.suffix),
    date_of_birth: c.dob || null,
    sex: c.sex || null,
    street: blankToNull(c.street),
    street_line_2: blankToNull(c.streetLine2),
    city: blankToNull(c.city),
    state: blankToNull(c.state),
    postal_code: blankToNull(c.postalCode),
    country_code: c.countryCode || "US",
    phone_home: blankToNull(c.phoneHome),
    phone_cell: blankToNull(c.phoneCell),
    email: blankToNull(c.email),
    // Same defaults as the Add Patient form.
    zone: "green",
    status: "active",
    occupation: blankToNull(c.occupation),
    ...(c.note ? { notes: c.note } : {}),
  };
}

function buildStaffInput(contact: CsvContact): StaffInput {
  const c = contact.candidate;
  return {
    email: c.email.trim().toLowerCase(),
    fname: c.fname.trim(),
    mname: blankToNull(c.mname),
    lname: c.lname.trim(),
    suffix: blankToNull(contact.suffix),
    title: blankToNull(c.orgTitle),
    organization: blankToNull(c.organization),
    specialty: blankToNull(c.occupation),
    // users.phone is the main number (Work/Main label, else the
    // home number); phonecell is the Mobile-labeled number.
    phone: blankToNull(contact.phones.main || contact.phones.home),
    phonecell: blankToNull(contact.phones.cell),
    role: "clinician",
    authorized: false,
  };
}

export default function CsvImport({
  user,
  apiConnected,
  onPatientsImported,
}: Props) {
  const [flow, setFlow] = useState<Target | null>(null);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState("");
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [dupCheckFailed, setDupCheckFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Staff import PIN gate (verified PIN held in memory only while
  // this card's flow is open).
  const [pinGateOpen, setPinGateOpen] = useState(false);
  const [pinEntry, setPinEntry] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinChecking, setPinChecking] = useState(false);
  const [verifiedPin, setVerifiedPin] = useState("");
  const [authorizer, setAuthorizer] = useState("");

  if (!apiConnected) {
    return (
      <article className="card">
        <strong>Database utilities</strong>
        <p>
          Importing patients or staff from a CSV file writes to the
          CareTask database — it can't run while the API is
          unreachable.
        </p>
      </article>
    );
  }

  function openFlow(target: Target) {
    setFlow(target);
    setFileName("");
    setParseError("");
    setRows(null);
    setDupCheckFailed(false);
    setSummary(null);
    setPinGateOpen(false);
    setPinEntry("");
    setPinError("");
  }

  function closeFlow() {
    setFlow(null);
    setRows(null);
    setSummary(null);
    setPinGateOpen(false);
    setVerifiedPin("");
    setAuthorizer("");
  }

  function buildRows(
    target: Target,
    contacts: CsvContact[],
    existingPatients: PersonUnderCare[] | null,
    existingStaff: ApiUser[] | null,
  ): PreviewRow[] {
    const patientKeys = new Set(
      (existingPatients ?? []).map(
        (p) =>
          `${(p.fname ?? "").trim().toLowerCase()}|${(p.lname ?? "").trim().toLowerCase()}`,
      ),
    );
    const teamEmails = new Set(
      (existingStaff ?? []).map((m) => m.email.toLowerCase()),
    );
    const seenEmails = new Set<string>();
    return contacts.map((contact, i) => {
      const c = contact.candidate;
      const base = {
        key: `${c.resourceName}-${i}`,
        contact,
        checked: false,
      };
      if (target === "patients") {
        const missing = missingPatientFields(contact);
        if (missing.length > 0) {
          return {
            ...base,
            status: "missing" as RowStatus,
            label: "Missing required",
            detail: `Missing: ${missing.join(", ")}`,
          };
        }
        const key = `${c.fname.trim().toLowerCase()}|${c.lname.trim().toLowerCase()}`;
        if (existingPatients && patientKeys.has(key)) {
          const match = existingPatients.find(
            (p) =>
              (p.fname ?? "").trim().toLowerCase() ===
                c.fname.trim().toLowerCase() &&
              (p.lname ?? "").trim().toLowerCase() ===
                c.lname.trim().toLowerCase(),
          );
          const sameDob = !!c.dob && match?.dateOfBirth === c.dob;
          return {
            ...base,
            status: "duplicate" as RowStatus,
            label: "Possible duplicate",
            detail: sameDob
              ? "Same name and date of birth as an existing patient"
              : "Same name as an existing patient",
          };
        }
        return {
          ...base,
          status: "ready" as RowStatus,
          label: "Ready",
          detail: "",
          checked: true,
        };
      }
      // Staff.
      const missing = missingStaffFields(contact);
      if (missing.length > 0) {
        return {
          ...base,
          status: "missing" as RowStatus,
          label: "Missing required",
          detail: `Missing: ${missing.join(", ")}`,
        };
      }
      const email = c.email.trim().toLowerCase();
      if (existingStaff && teamEmails.has(email)) {
        return {
          ...base,
          status: "team" as RowStatus,
          label: "Already on the team",
          detail: email,
        };
      }
      if (seenEmails.has(email)) {
        return {
          ...base,
          status: "infile" as RowStatus,
          label: "Duplicate in file",
          detail: email,
        };
      }
      seenEmails.add(email);
      return {
        ...base,
        status: "ready" as RowStatus,
        label: "Ready",
        detail: "",
        checked: true,
      };
    });
  }

  async function onFileChosen(file: File, target: Target) {
    setFileName(file.name);
    setParseError("");
    setSummary(null);
    setRows(null);
    try {
      // Parse locally and load the existing records for the
      // duplicate checks in parallel. A failed existing-records
      // load doesn't block the import — it just disables the
      // duplicate statuses, and the preview says so.
      const [text, patients, staff] = await Promise.all([
        file.text(),
        target === "patients"
          ? listPatients(user).catch(() => null)
          : Promise.resolve(null),
        target === "staff"
          ? listUsers(user).catch(() => null)
          : Promise.resolve(null),
      ]);
      const contacts = parseGoogleContactsCsv(text);
      if (contacts.length === 0) {
        setParseError("No importable contacts were found in that file.");
        return;
      }
      setDupCheckFailed(
        (target === "patients" && patients === null) ||
          (target === "staff" && staff === null),
      );
      setRows(buildRows(target, contacts, patients, staff));
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : "Couldn't read that file.",
      );
    }
  }

  function toggleRow(key: string) {
    setRows((prev) =>
      (prev ?? []).map((r) =>
        r.key === key && r.status === "ready"
          ? { ...r, checked: !r.checked }
          : r,
      ),
    );
  }

  function toggleAllReady(checked: boolean) {
    setRows((prev) =>
      (prev ?? []).map((r) =>
        r.status === "ready" ? { ...r, checked } : r,
      ),
    );
  }

  const selectedRows = (rows ?? []).filter(
    (r) => r.checked && r.status === "ready",
  );

  async function doImportPatients() {
    if (!flow || flow !== "patients" || selectedRows.length === 0) return;
    setSaving(true);
    const created: PersonUnderCare[] = [];
    const failures: { name: string; reason: string }[] = [];
    const results = new Map<string, string>();
    for (const row of selectedRows) {
      try {
        const person = await createPatient(
          user,
          buildPatientInput(row.contact),
        );
        created.push(person);
        results.set(row.key, "Imported");
      } catch (err) {
        const e = err as { code?: string; message?: string } | null;
        failures.push({
          name: row.contact.candidate.displayName,
          reason: e?.code ?? e?.message ?? "Save failed",
        });
        results.set(row.key, "Failed");
      }
    }
    setRows((prev) =>
      (prev ?? []).map((r) =>
        results.has(r.key)
          ? { ...r, result: results.get(r.key), checked: false }
          : r,
      ),
    );
    if (created.length > 0) onPatientsImported?.(created);
    setSummary({
      imported: created.length,
      failed: failures.length,
      skipped: (rows ?? []).length - created.length - failures.length,
      failures,
    });
    setSaving(false);
  }

  async function doImportStaff(pin: string) {
    if (!flow || flow !== "staff" || selectedRows.length === 0) return;
    setSaving(true);
    let imported = 0;
    let failed = 0;
    const failures: { name: string; reason: string }[] = [];
    const results = new Map<string, string>();
    for (const row of selectedRows) {
      try {
        await createStaff(user, buildStaffInput(row.contact), pin);
        imported += 1;
        results.set(row.key, "Imported");
      } catch (err) {
        if (isPinRejection(err)) {
          // Stop immediately — every further write would fail the
          // same way. Keep the partial counts honest and send the
          // user back to the PIN gate.
          failures.push({
            name: row.contact.candidate.displayName,
            reason: "PIN rejected by the server — import stopped",
          });
          failed += 1;
          setVerifiedPin("");
          setPinError("That PIN was rejected — try again.");
          setPinGateOpen(true);
          break;
        }
        const code = (err as { code?: string } | null)?.code;
        if (code === "EMAIL_EXISTS") {
          results.set(row.key, "Already on the team");
        } else {
          failed += 1;
          failures.push({
            name: row.contact.candidate.displayName,
            reason: code ?? "Save failed",
          });
          results.set(row.key, "Failed");
        }
      }
    }
    setRows((prev) =>
      (prev ?? []).map((r) =>
        results.has(r.key)
          ? { ...r, result: results.get(r.key), checked: false }
          : r,
      ),
    );
    setSummary({
      imported,
      failed,
      skipped: (rows ?? []).length - imported - failed,
      failures,
    });
    setSaving(false);
  }

  function requestImport() {
    if (!flow || selectedRows.length === 0) return;
    setSummary(null);
    if (flow === "patients") {
      void doImportPatients();
    } else if (verifiedPin) {
      void doImportStaff(verifiedPin);
    } else {
      setPinError("");
      setPinEntry("");
      setPinGateOpen(true);
    }
  }

  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    const pin = pinEntry.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      setPinError("PINs are 4–8 digits.");
      return;
    }
    setPinChecking(true);
    setPinError("");
    try {
      const manager = await verifyManagerPin(user, pin);
      setVerifiedPin(pin);
      setAuthorizer(manager.name);
      setPinGateOpen(false);
      setPinEntry("");
      void doImportStaff(pin);
    } catch (err) {
      setPinError(
        isPinRejection(err)
          ? "Incorrect PIN"
          : "Couldn't verify the PIN — check the connection and try again.",
      );
    } finally {
      setPinChecking(false);
    }
  }

  const counts = {
    total: (rows ?? []).length,
    ready: (rows ?? []).filter((r) => r.status === "ready").length,
    duplicate: (rows ?? []).filter((r) => r.status === "duplicate").length,
    team: (rows ?? []).filter((r) => r.status === "team").length,
    infile: (rows ?? []).filter((r) => r.status === "infile").length,
    missing: (rows ?? []).filter((r) => r.status === "missing").length,
  };
  const allReadyChecked =
    counts.ready > 0 &&
    (rows ?? []).every((r) => r.status !== "ready" || r.checked);

  return (
    <article className="card">
      <div className="card-top">
        <strong>Database utilities</strong>
      </div>
      <p>Import from CSV</p>
      <div className="flag-actions">
        <button
          className="btn btn-primary"
          onClick={() => openFlow("patients")}
        >
          Import patients
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => openFlow("staff")}
        >
          Import staff
        </button>
      </div>

      {flow && (
        <div className="csv-import-panel">
          <div className="card-top">
            <strong>
              {flow === "patients"
                ? "Import patients from CSV"
                : "Import staff from CSV"}
            </strong>
            <button
              className="btn btn-secondary"
              onClick={closeFlow}
              disabled={saving}
            >
              Close
            </button>
          </div>
          <p className="section-note">
            {flow === "patients"
              ? "Patients need a first and last name — rows missing either can't be imported. Date of birth and sex are optional."
              : "Staff need an email, first name, and last name. Imported staff start as clinicians who are not yet authorized; a manager can change the role afterwards. A manager PIN is required to save."}
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void onFileChosen(f, flow);
            }}
          />
          <div className="flag-actions">
            <button
              className="btn btn-secondary"
              onClick={() => fileRef.current?.click()}
              disabled={saving}
            >
              Choose CSV file
            </button>
            {fileName && (
              <span className="card-meta">{fileName}</span>
            )}
          </div>
          {parseError && <p className="pin-error">{parseError}</p>}
          {dupCheckFailed && rows && (
            <p className="section-note">
              Duplicate checking wasn't available (the existing records
              couldn't be loaded), so rows aren't flagged against the
              current database.
            </p>
          )}

          {rows && (
            <>
              <p className="card-meta">
                {counts.total} rows · {counts.ready} ready
                {counts.duplicate > 0 &&
                  ` · ${counts.duplicate} possible duplicates`}
                {counts.team > 0 && ` · ${counts.team} already on the team`}
                {counts.infile > 0 &&
                  ` · ${counts.infile} duplicates in file`}
                {counts.missing > 0 &&
                  ` · ${counts.missing} missing required fields`}
              </p>
              <div className="csv-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          checked={allReadyChecked}
                          onChange={(e) =>
                            toggleAllReady(e.target.checked)
                          }
                          aria-label="Select all ready rows"
                        />
                      </th>
                      <th>Name</th>
                      {flow === "patients" ? (
                        <>
                          <th>Date of birth</th>
                          <th>Sex</th>
                          <th>Email</th>
                          <th>Phone</th>
                        </>
                      ) : (
                        <>
                          <th>Email</th>
                          <th>Phone</th>
                          <th>Organization</th>
                        </>
                      )}
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 500).map((r) => {
                      const c = r.contact.candidate;
                      return (
                        <tr key={r.key}>
                          <td>
                            <input
                              type="checkbox"
                              checked={r.checked}
                              disabled={r.status !== "ready" || saving}
                              onChange={() => toggleRow(r.key)}
                              aria-label={`Import ${c.displayName}`}
                            />
                          </td>
                          <td>{c.displayName}</td>
                          {flow === "patients" ? (
                            <>
                              <td>{c.dob || "—"}</td>
                              <td>{c.sex || "—"}</td>
                              <td>{c.email || "—"}</td>
                              <td>{c.phoneCell || c.phoneHome || "—"}</td>
                            </>
                          ) : (
                            <>
                              <td>{c.email || "—"}</td>
                              <td>
                                {r.contact.phones.cell ||
                                  r.contact.phones.main ||
                                  r.contact.phones.home ||
                                  "—"}
                              </td>
                              <td>{c.organization || "—"}</td>
                            </>
                          )}
                          <td>
                            <span
                              className={`csv-status csv-status-${r.status}`}
                            >
                              {r.result ?? r.label}
                            </span>
                            {!r.result && r.detail && (
                              <span className="card-meta">
                                {" "}
                                — {r.detail}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {rows.length > 500 && (
                <p className="section-note">
                  Showing the first 500 rows; the counts above and the
                  Import button cover all {rows.length} rows (ready rows
                  start checked, including any beyond the preview).
                </p>
              )}
              {authorizer && flow === "staff" && (
                <p className="card-meta">
                  Manager PIN verified for {authorizer}.
                </p>
              )}
              <div className="flag-actions">
                <button
                  className="btn btn-primary"
                  onClick={requestImport}
                  disabled={saving || selectedRows.length === 0}
                >
                  {saving
                    ? "Importing…"
                    : `Import ${selectedRows.length} ${
                        flow === "patients" ? "patients" : "staff"
                      }`}
                </button>
              </div>
            </>
          )}

          {pinGateOpen && (
            <form className="pin-panel" onSubmit={submitPin}>
              <label>
                Manager PIN required to import staff
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pinEntry}
                  onChange={(e) => setPinEntry(e.target.value)}
                  placeholder="PIN"
                />
              </label>
              <p>Enter any active manager or admin PIN.</p>
              {pinError && <p className="pin-error">{pinError}</p>}
              <div className="profile-actions">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={pinChecking}
                >
                  {pinChecking ? "Verifying…" : "Unlock"}
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => setPinGateOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {summary && (
            <div className="csv-summary">
              <p>
                Imported {summary.imported} · Skipped {summary.skipped} ·
                Failed {summary.failed}
              </p>
              {summary.failures.length > 0 && (
                <ul className="csv-failures">
                  {summary.failures.map((f, i) => (
                    <li key={i}>
                      {f.name} — {f.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
