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
// - Staff import is role-gated (manager/admin): the API rejects
//   staff writes from any other role, and this card only offers
//   the staff flow to managers (the manager PIN was retired on
//   2026-11-02). Imported staff start as unauthorized clinicians.
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
  fetchAgencies,
  getPatient,
  isRoleRejection,
  linkPatient,
  listPatients,
  listUsers,
  type ApiAgency,
  type ApiRequestError,
  type ApiUser,
  type NewApiPatient,
  type PatientStatus,
  type StaffInput,
} from "../lib/patientApi";
import { isManagerRole, useMyStaff } from "../lib/useMyRole";
import AgencyPicker from "./AgencyPicker";

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
  // Patients flow only: the agency + status this row will be
  // saved with. Set in bulk by the batch controls at the top of
  // the preview (Jake, 2026-11-02 — the Google Contacts label
  // model), overridable per row.
  agencyId: number | null;
  agencyText: string | null;
  patientStatus: PatientStatus;
}

interface ImportSummary {
  imported: number;
  // Patients flow only: rows the registry already held, linked to
  // the caller's list instead of re-created (platform dedupe).
  linked: number;
  skipped: number;
  failed: number;
  failures: { name: string; reason: string }[];
}

const blankToNull = (s: string): string | null => {
  const t = s.trim();
  return t ? t : null;
};

function buildPatientInput(
  contact: CsvContact,
  row: PreviewRow,
): NewApiPatient {
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
    // Zone default matches the Add Patient form; the STATUS and
    // agency come from the row (batch controls + per-row override).
    zone: "green",
    status: row.patientStatus,
    agency_id: row.agencyId,
    agency_name_text: row.agencyText,
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
  const me = useMyStaff(user);
  const isManager = isManagerRole(me);
  const [flow, setFlow] = useState<Target | null>(null);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState("");
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [dupCheckFailed, setDupCheckFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Batch agency/status (patients flow): the agency directory for
  // the per-row selects, loaded once; the batch picker + status
  // apply to every row, per-row selects override.
  const [agencies, setAgencies] = useState<ApiAgency[] | null>(null);
  const [batchAgencyId, setBatchAgencyId] = useState<number | null>(null);
  const [batchAgencyText, setBatchAgencyText] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<PatientStatus>("active");

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
    setBatchAgencyId(null);
    setBatchAgencyText(null);
    setBatchStatus("active");
    if (target === "patients" && agencies === null) {
      fetchAgencies(user, { active: true })
        .then(setAgencies)
        .catch(() => setAgencies([]));
    }
  }

  function applyBatchAgency(sel: {
    agencyId: number | null;
    agencyNameText: string | null;
  }) {
    setBatchAgencyId(sel.agencyId);
    setBatchAgencyText(sel.agencyNameText);
    setRows((prev) =>
      (prev ?? []).map((r) => ({
        ...r,
        agencyId: sel.agencyId,
        agencyText: sel.agencyNameText,
      })),
    );
  }

  function applyBatchStatus(status: PatientStatus) {
    setBatchStatus(status);
    setRows((prev) =>
      (prev ?? []).map((r) => ({ ...r, patientStatus: status })),
    );
  }

  function setRowAgency(key: string, value: string) {
    setRows((prev) =>
      (prev ?? []).map((r) => {
        if (r.key !== key) return r;
        if (value === "") return { ...r, agencyId: null, agencyText: null };
        if (value.startsWith("text:"))
          return { ...r, agencyId: null, agencyText: value.slice(5) };
        return { ...r, agencyId: Number(value.slice(3)), agencyText: null };
      }),
    );
  }

  function setRowStatus(key: string, status: PatientStatus) {
    setRows((prev) =>
      (prev ?? []).map((r) =>
        r.key === key ? { ...r, patientStatus: status } : r,
      ),
    );
  }

  function closeFlow() {
    setFlow(null);
    setRows(null);
    setSummary(null);
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
        agencyId: null,
        agencyText: null,
        patientStatus: "active" as PatientStatus,
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
    let linked = 0;
    const failures: { name: string; reason: string }[] = [];
    const results = new Map<string, string>();
    for (const row of selectedRows) {
      try {
        const person = await createPatient(
          user,
          buildPatientInput(row.contact, row),
        );
        created.push(person);
        results.set(row.key, "Imported");
      } catch (err) {
        const e = err as ApiRequestError | null;
        // Platform registry dedupe (2026-11-03): the server checks
        // the whole registry, not just my list, so rows my preview
        // couldn't flag land here. An exact match links instead of
        // failing; a possible match is left for a human decision in
        // the Add Patient form — never auto-created from a batch.
        if (e?.code === "PATIENT_EXISTS") {
          const body = e.body as {
            patient?: { id: string };
          } | null;
          try {
            if (!body?.patient?.id) throw new Error("no patient id");
            await linkPatient(user, body.patient.id);
            created.push(await getPatient(user, body.patient.id));
            linked += 1;
            results.set(row.key, "Added to my list");
          } catch {
            failures.push({
              name: row.contact.candidate.displayName,
              reason: "Already in the registry, but linking failed",
            });
            results.set(row.key, "Failed");
          }
        } else if (e?.code === "POSSIBLE_MATCH") {
          failures.push({
            name: row.contact.candidate.displayName,
            reason:
              "Possible match in the registry — review it from the Add Patient form",
          });
          results.set(row.key, "Possible match");
        } else {
          failures.push({
            name: row.contact.candidate.displayName,
            reason: e?.code ?? e?.message ?? "Save failed",
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
    if (created.length > 0) onPatientsImported?.(created);
    setSummary({
      imported: created.length - linked,
      linked,
      failed: failures.length,
      skipped:
        (rows ?? []).length - created.length - failures.length,
      failures,
    });
    setSaving(false);
  }

  async function doImportStaff() {
    if (!flow || flow !== "staff" || selectedRows.length === 0) return;
    setSaving(true);
    let imported = 0;
    let failed = 0;
    const failures: { name: string; reason: string }[] = [];
    const results = new Map<string, string>();
    for (const row of selectedRows) {
      try {
        await createStaff(user, buildStaffInput(row.contact));
        imported += 1;
        results.set(row.key, "Imported");
      } catch (err) {
        if (isRoleRejection(err)) {
          // Stop immediately — every further write would fail the
          // same way. Keep the partial counts honest.
          failures.push({
            name: row.contact.candidate.displayName,
            reason: "Adding staff needs a manager or admin role — import stopped",
          });
          failed += 1;
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
      linked: 0,
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
    } else {
      void doImportStaff();
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
        {isManager && (
          <button
            className="btn btn-secondary"
            onClick={() => openFlow("staff")}
          >
            Import staff
          </button>
        )}
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
              : "Staff need an email, first name, and last name. Imported staff start as clinicians who are not yet authorized; a manager can change the role afterwards."}
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
              {flow === "patients" && (
                <div className="csv-batch">
                  <span className="csv-batch-label">Apply to all rows:</span>
                  <div className="csv-batch-agency">
                    <AgencyPicker
                      user={user}
                      apiConnected={apiConnected}
                      agencyId={batchAgencyId}
                      agencyNameText={batchAgencyText}
                      onChange={(sel) =>
                        applyBatchAgency({
                          agencyId: sel.agencyId,
                          agencyNameText: sel.agencyNameText ?? null,
                        })
                      }
                      patientCity=""
                      resetKey={fileName || "csv-batch"}
                    />
                  </div>
                  <div className="csv-batch-status">
                    <span>Status</span>
                    <select
                      value={batchStatus}
                      onChange={(e) =>
                        applyBatchStatus(e.target.value as PatientStatus)
                      }
                      disabled={saving}
                      aria-label="Status for all rows"
                    >
                      <option value="active">Active</option>
                      <option value="hold">On hold</option>
                      <option value="discharged">Discharged</option>
                    </select>
                  </div>
                </div>
              )}
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
                          <th>Agency</th>
                          <th>Save as</th>
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
                              <td>
                                <select
                                  className="csv-row-select"
                                  value={
                                    r.agencyText
                                      ? `text:${r.agencyText}`
                                      : r.agencyId != null
                                        ? `id:${r.agencyId}`
                                        : ""
                                  }
                                  onChange={(e) =>
                                    setRowAgency(r.key, e.target.value)
                                  }
                                  disabled={
                                    saving || r.result === "Imported"
                                  }
                                  aria-label={`Agency for ${c.displayName}`}
                                >
                                  <option value="">No agency</option>
                                  {r.agencyText && (
                                    <option value={`text:${r.agencyText}`}>
                                      {r.agencyText} (typed)
                                    </option>
                                  )}
                                  {(agencies ?? []).map((a) => (
                                    <option key={a.id} value={`id:${a.id}`}>
                                      {a.display_name}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <select
                                  className="csv-row-select"
                                  value={r.patientStatus}
                                  onChange={(e) =>
                                    setRowStatus(
                                      r.key,
                                      e.target.value as PatientStatus,
                                    )
                                  }
                                  disabled={
                                    saving || r.result === "Imported"
                                  }
                                  aria-label={`Status for ${c.displayName}`}
                                >
                                  <option value="active">Active</option>
                                  <option value="hold">On hold</option>
                                  <option value="discharged">
                                    Discharged
                                  </option>
                                </select>
                              </td>
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

          {summary && (
            <div className="csv-summary">
              <p>
                Imported {summary.imported}
                {summary.linked > 0 &&
                  ` · Added to my list ${summary.linked}`}{" "}
                · Skipped {summary.skipped} · Failed {summary.failed}
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
