// Patient API client for the CareTask dashboard.
//
// Talks to the Marc Innotech demo patient API (see
// workspace/marc-innotech/patient-api/) when VITE_API_URL is set, and
// reports failure so the dashboard can fall back to its in-browser demo
// data. Nothing in this module changes the DEMO DATA banner, the theme,
// or the icons — it only changes where the patient list comes from.
//
// API patient shape (snake_case, as returned by the API), v2 schema:
// split name/address/phone, demographics, care/other, sensitive,
// billing, and pharmacy fields. See
// workspace/marc-innotech/patient-api/schema-patients-v2.sql.
// NOTE: ss and drivers_license are returned by the API (and appear in
// audit snapshots) but are deliberately NOT rendered in the dashboard
// UI — minimization: no dashboard view needs to display them.
import type { User } from "firebase/auth";
import type { PersonUnderCare, TrafficLight } from "./demoData";
import type { DocType } from "./documentTemplates";

export type PatientStatus = "active" | "hold" | "discharged";

export interface ApiPatient {
  id: string;
  title: string | null;
  fname: string;
  mname: string | null;
  lname: string;
  suffix: string | null;
  preferred_name: string | null;
  date_of_birth: string | null;
  // Stored age in years (schema-patients-age.sql) — fallback
  // for patients whose birth date is unknown; display prefers
  // the age derived from date_of_birth when that is set.
  age: number | null;
  sex: string | null;
  race: string | null;
  ethnicity: string | null;
  language: string | null;
  street: string | null;
  street_line_2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  phone_home: string | null;
  phone_cell: string | null;
  email: string | null;
  zone: TrafficLight;
  flags: string[];
  notes: string | null;
  clinician: string | null;
  occupation: string | null;
  interpreter_needed: boolean;
  hipaa_allowsms: boolean;
  hipaa_allowemail: boolean;
  referrer: string | null;
  status: PatientStatus;
  emergency_contact_name: string | null;
  emergency_contact_relationship: string | null;
  emergency_contact_phone: string | null;
  ss: string | null;
  drivers_license: string | null;
  billing_note: string | null;
  pricelevel: string;
  financial: string | null;
  pharmacy_id: number | null;
  // Agency tag (schema-patients-agency.sql): agency_id links
  // the IDPH directory (int8 → string from pg); agency_name is
  // the API-resolved read field (linked display_name, else the
  // free-text fallback). Never both stored at once.
  agency_id: string | number | null;
  agency_name_text: string | null;
  agency_name: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface NewApiPatient {
  title?: string | null;
  fname: string;
  mname?: string | null;
  lname: string;
  suffix?: string | null;
  preferred_name?: string | null;
  date_of_birth?: string | null;
  age?: number | null;
  sex?: string | null;
  race?: string | null;
  ethnicity?: string | null;
  language?: string | null;
  street?: string | null;
  street_line_2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country_code?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  phone_home?: string | null;
  phone_cell?: string | null;
  email?: string | null;
  zone: TrafficLight;
  flags?: string[];
  notes?: string;
  clinician?: string;
  occupation?: string | null;
  interpreter_needed?: boolean;
  hipaa_allowsms?: boolean;
  hipaa_allowemail?: boolean;
  referrer?: string | null;
  status?: PatientStatus;
  emergency_contact_name?: string | null;
  emergency_contact_relationship?: string | null;
  emergency_contact_phone?: string | null;
  ss?: string | null;
  drivers_license?: string | null;
  billing_note?: string | null;
  pricelevel?: string;
  financial?: string | null;
  pharmacy_id?: number | null;
  agency_id?: number | null;
  agency_name_text?: string | null;
  // Platform dedupe (2026-11-03): set only when the user reviewed
  // a POSSIBLE_MATCH prompt and chose "Create anyway". Recorded
  // server-side as a known non-duplicate so the same intake data
  // never prompts again.
  confirm_create?: boolean;
}

// The API base URL, e.g. https://api.marcinnotech.net for the live API
// or http://localhost:3001 for local dev. Null when unset — the caller
// treats that as "no API configured" and keeps the in-browser demo data.
export function apiBase(): string | null {
  const raw = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
  const base = raw.trim().replace(/\/+$/, "");
  return base ? base : null;
}

export function isApiConfigured(): boolean {
  return apiBase() !== null;
}

// Derive a decade band ("70s") from a YYYY-MM-DD birth date. v2
// dropped the stored age_band column — date_of_birth is the source
// of truth, and the band is always derived.
// Exact age in years from a YYYY-MM-DD birth date (birthday-aware),
// or null when the date is missing/unparseable. The profile header
// shows this instead of the decade band.
export function ageFromDob(dob: string | null): number | null {
  if (!dob) return null;
  const birth = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age -= 1;
  return age >= 0 ? age : null;
}

export function ageBandFromDob(dob: string | null): string {
  if (!dob) return "—";
  const year = Number(dob.slice(0, 4));
  if (!Number.isFinite(year)) return "—";
  const age = new Date().getFullYear() - year;
  const decade = Math.floor(age / 10) * 10;
  return `${decade}s`;
}

// Full display name: "First Middle Last Suffix", blank parts
// skipped. The honorific title is deliberately NOT composed
// in (Jake, 2026-10-30 — display only: the title column and
// API field stay as stored). The preferred name, when set, is
// what the list and profile show as the primary name
// (toPersonUnderCare below).
export function fullName(p: ApiPatient): string {
  return [p.fname, p.mname, p.lname, p.suffix]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

export function displayName(p: ApiPatient): string {
  return p.preferred_name?.trim() ? p.preferred_name : fullName(p);
}

// ------------------------------------------------------------- pg types
//
// The API's pg driver returns two column types in shapes the
// dashboard was not written against, so both are normalized here,
// once, at the client boundary:
//
// - DATE columns arrive as JS Date objects, which JSON-serialize
//   as full ISO timestamps ("1961-07-22T00:00:00.000Z"). The
//   dashboard works in plain YYYY-MM-DD dates — <input
//   type="date"> values, age math, and the exact-match duplicate
//   checks — so a timestamp DOB left the Edit form's birthday
//   field EMPTY and saves never stuck ("birthday doesn't save").
//   dateOnly() keeps the first 10 chars of any longer string;
//   values already YYYY-MM-DD (and nulls) pass through untouched.
//   date_of_birth is the only DATE-only column on ApiPatient
//   (created_at / updated_at / deleted_at are timestamps, where
//   the full string is correct). Appointment date/time fields
//   are deliberately never passed through this — the calendar
//   parses full timestamps on purpose.
// - BIGINT columns arrive as strings ("446"). ApiAgency.id is
//   typed number and consumers compare with ===, so a string id
//   never matched the patient's numeric agency_id and the agency
//   picker fell back to "Agency #446" instead of the name.
export function dateOnly(value: string | null): string | null {
  return typeof value === "string" && value.length > 10
    ? value.slice(0, 10)
    : value;
}

export function normalizeApiPatient(p: ApiPatient): ApiPatient {
  return { ...p, date_of_birth: dateOnly(p.date_of_birth) };
}

export function normalizeApiAgency(a: ApiAgency): ApiAgency {
  return { ...a, id: Number(a.id) };
}

// Map an API patient onto the dashboard's PersonUnderCare view model.
// The view model's `name` is the display name (preferred name when
// set, else the full split name); the raw v2 fields travel alongside
// as optional properties for the Patient Profile view. Fields the API
// does not track (last check-in, next review) show as "—"; the demo
// schedule and reminders stay keyed by name and keep working for the
// in-browser fictional patients.
export function toPersonUnderCare(raw: ApiPatient): PersonUnderCare {
  const p = normalizeApiPatient(raw);
  return {
    id: p.id,
    name: displayName(p),
    ageBand: ageBandFromDob(p.date_of_birth),
    status: p.zone,
    statusNote: p.notes ?? "—",
    lastCheckIn: "—",
    nextReview: "—",
    clinician: p.clinician ?? "Unassigned",
    title: p.title,
    fname: p.fname,
    mname: p.mname,
    lname: p.lname,
    suffix: p.suffix,
    preferredName: p.preferred_name,
    dateOfBirth: p.date_of_birth,
    age: p.age ?? null,
    sex: p.sex,
    race: p.race,
    ethnicity: p.ethnicity,
    language: p.language,
    street: p.street,
    streetLine2: p.street_line_2,
    city: p.city,
    state: p.state,
    postalCode: p.postal_code,
    countryCode: p.country_code,
    latitude: p.latitude ?? null,
    longitude: p.longitude ?? null,
    phoneHome: p.phone_home,
    phoneCell: p.phone_cell,
    email: p.email,
    occupation: p.occupation,
    interpreterNeeded: p.interpreter_needed,
    hipaaAllowsSms: p.hipaa_allowsms,
    hipaaAllowsEmail: p.hipaa_allowemail,
    referrer: p.referrer,
    patientStatus: p.status,
    emergencyContactName: p.emergency_contact_name,
    emergencyContactRelationship: p.emergency_contact_relationship,
    emergencyContactPhone: p.emergency_contact_phone,
    billingNote: p.billing_note,
    pricelevel: p.pricelevel,
    financial: p.financial,
    pharmacyId: p.pharmacy_id,
    agencyId:
      p.agency_id === null || p.agency_id === undefined
        ? null
        : Number(p.agency_id),
    agencyNameText: p.agency_name_text,
    agencyName: p.agency_name,
  };
}

async function apiFetch(
  user: User,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const base = apiBase();
  if (!base) throw new Error("patient API is not configured");
  const token = await user.getIdToken();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
    // A dead API must not hang the dashboard: fall back to demo data.
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    // Surface the API's error code (e.g. ROLE_REQUIRED on
    // manager-gated writes) alongside the status, so callers can react
    // specifically instead of treating every failure as a dead API.
    // The parsed body rides along too: the platform's 409s carry the
    // payload the UI needs (PATIENT_EXISTS → the existing patient,
    // POSSIBLE_MATCH → the candidates).
    let code: string | undefined;
    let body: unknown;
    try {
      body = (await res.json()) as { code?: string } | null;
      code = (body as { code?: string } | null)?.code;
    } catch {
      // Non-JSON error body — status alone will have to do.
    }
    const err = new Error(
      `patient API request failed: ${res.status}`,
    ) as ApiRequestError;
    err.status = res.status;
    err.code = code;
    err.body = body;
    throw err;
  }
  // 204 (e.g. soft delete) carries no body — do not parse one.
  if (res.status === 204) return null;
  return res.json();
}

// An API failure with the HTTP status and the API's error code (when
// it sent one) attached.
export interface ApiRequestError extends Error {
  status?: number;
  code?: string;
  // The API's parsed error body, when it sent JSON (the platform
  // 409s carry their payload here — see apiFetch).
  body?: unknown;
}

// True when the API rejected a manager-gated write because the
// caller's staff role is not manager/admin (or the caller has no
// staff record at all). Callers use this to explain the failure
// plainly instead of reporting a generic save failure. (The
// manager PIN was retired on 2026-11-02 in favor of role gates.)
export function isRoleRejection(err: unknown): boolean {
  const e = err as ApiRequestError | null;
  return e?.code === "ROLE_REQUIRED" || e?.code === "NO_STAFF_RECORD";
}

export async function listPatients(
  user: User,
): Promise<PersonUnderCare[]> {
  const rows = (await apiFetch(user, "/patients?limit=200")) as ApiPatient[];
  return rows.map(toPersonUnderCare);
}

// Raw patient search (GET /patients?q=) — the API matches the query
// against first name, last name, preferred name, or email. The Add
// Patient form's duplicate check queries by last name and compares
// first + last name exactly on the client.
export async function searchPatients(
  user: User,
  q: string,
): Promise<ApiPatient[]> {
  const params = new URLSearchParams({ q, limit: "50" });
  const rows = (await apiFetch(
    user,
    `/patients?${params.toString()}`,
  )) as ApiPatient[];
  return rows.map(normalizeApiPatient);
}

export async function getPatient(
  user: User,
  id: string,
): Promise<PersonUnderCare> {
  const row = (await apiFetch(
    user,
    `/patients/${encodeURIComponent(id)}`,
  )) as ApiPatient;
  return toPersonUnderCare(row);
}

export async function createPatient(
  user: User,
  input: NewApiPatient,
): Promise<PersonUnderCare> {
  const row = (await apiFetch(user, "/patients", {
    method: "POST",
    body: JSON.stringify(input),
  })) as ApiPatient;
  return toPersonUnderCare(row);
}

// Update an existing patient (PUT /patients/:id). Partial payloads
// are fine — fields not sent keep their stored values. NOT gated:
// clinicians manage their own patients — a status change to hold
// or discharged is how a clinician takes someone off their list.
export async function updatePatient(
  user: User,
  id: string,
  input: Partial<NewApiPatient>,
): Promise<PersonUnderCare> {
  const row = (await apiFetch(
    user,
    `/patients/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  )) as ApiPatient;
  return toPersonUnderCare(row);
}

// Soft-delete a patient (the API keeps the row, sets deleted_at).
// ROLE-GATED (manager/admin) — true deletion is a manager act;
// clinicians remove patients from their list via status instead.
export interface ApiMessage {
  id: string;
  thread_id: string;
  sender_id: string;
  sender_name: string;
  sender_email: string;
  recipient_id: string | null;
  recipient_name: string | null;
  patient_id: string | null;
  patient_name: string | null;
  subject: string | null;
  body: string;
  read_at: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface MessageInput {
  recipient_id?: string | null;
  patient_id?: string | null;
  subject?: string | null;
  body: string;
  thread_id?: string | null;
}

export async function listMessages(
  user: User,
  opts: { sent?: boolean; unread?: boolean } = {},
): Promise<{ messages: ApiMessage[]; meId: string }> {
  const qs = new URLSearchParams();
  if (opts.sent) qs.set("sent", "1");
  if (opts.unread) qs.set("unread", "1");
  const out = (await apiFetch(user, `/messages?${qs.toString()}`)) as {
    messages: ApiMessage[];
    me_id: string;
  };
  return { messages: out.messages, meId: out.me_id };
}

export async function listPatientMessages(
  user: User,
  patientId: string,
): Promise<ApiMessage[]> {
  const out = (await apiFetch(
    user,
    `/messages/patient/${encodeURIComponent(patientId)}`,
  )) as { messages: ApiMessage[] };
  return out.messages;
}

export async function getMessageThread(
  user: User,
  threadId: string,
): Promise<ApiMessage[]> {
  const out = (await apiFetch(
    user,
    `/messages/threads/${encodeURIComponent(threadId)}`,
  )) as { messages: ApiMessage[] };
  return out.messages;
}

export async function sendMessage(
  user: User,
  input: MessageInput,
): Promise<ApiMessage> {
  const out = (await apiFetch(user, "/messages", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { message: ApiMessage };
  return out.message;
}

export async function markMessageRead(
  user: User,
  id: string,
): Promise<ApiMessage> {
  const out = (await apiFetch(
    user,
    `/messages/${encodeURIComponent(id)}/read`,
    { method: "POST" },
  )) as { message: ApiMessage };
  return out.message;
}

export async function deleteMessage(user: User, id: string): Promise<void> {
  await apiFetch(user, `/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function deletePatient(
  user: User,
  id: string,
): Promise<void> {
  await apiFetch(user, `/patients/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// Undo a soft delete (the API clears deleted_at). ROLE-GATED
// (manager/admin), same as deletePatient.
export async function restorePatient(
  user: User,
  id: string,
): Promise<PersonUnderCare> {
  const row = (await apiFetch(
    user,
    `/patients/${encodeURIComponent(id)}/restore`,
    { method: "POST" },
  )) as ApiPatient;
  return toPersonUnderCare(row);
}

// ── Patient merge (duplicate records) ────────────────────────────
// Mark a suspected-duplicate pair → review queue → a manager merges
// (linked rows re-point to the survivor, the loser is retired, the
// merge is undoable). API: routes/patientMerge.js.

export interface MergePatientSummary {
  id: string;
  name: string;
  fname: string | null;
  lname: string | null;
  date_of_birth: string | null;
  age: number | null;
  sex: string | null;
  zone: string | null;
  status: string | null;
  address: string | null;
  phone_cell: string | null;
  phone_home: string | null;
  email: string | null;
  agency_id: number | null;
  agency_name_text: string | null;
  deleted: boolean;
}

export interface MergeMark {
  patient_low: string;
  patient_high: string;
  created_by: string;
  created_at: string;
  patient_a: MergePatientSummary;
  patient_b: MergePatientSummary;
}

export interface MergeRecord {
  id: number;
  survivor_id: string;
  loser_id: string;
  survivor_name: string;
  loser_name: string;
  merged_by: string;
  created_at: string;
  moved: {
    appointments: number;
    documents: number;
    messages: number;
    mileage_entries: number;
  };
  undone_at: string | null;
  undone_by: string | null;
}

export async function fetchMergeMarks(user: User): Promise<MergeMark[]> {
  const data = (await apiFetch(user, "/patient-merge/marks")) as {
    marks: MergeMark[];
  };
  return data.marks;
}

export async function markDuplicatePair(
  user: User,
  patientId: string,
  otherId: string,
): Promise<void> {
  await apiFetch(user, "/patient-merge/mark", {
    method: "POST",
    body: JSON.stringify({ patient_id: patientId, other_id: otherId }),
  });
}

export async function dismissMergeMark(
  user: User,
  patientId: string,
  otherId: string,
): Promise<void> {
  await apiFetch(user, "/patient-merge/mark/dismiss", {
    method: "POST",
    body: JSON.stringify({ patient_id: patientId, other_id: otherId }),
  });
}

export async function fetchMerges(user: User): Promise<MergeRecord[]> {
  const data = (await apiFetch(user, "/patient-merge")) as {
    merges: MergeRecord[];
  };
  return data.merges;
}

// ROLE-GATED (manager/admin) — the API answers 403 ROLE_REQUIRED
// for anyone else; isRoleRejection() recognizes it.
export async function mergePatients(
  user: User,
  survivorId: string,
  loserId: string,
): Promise<void> {
  await apiFetch(user, "/patient-merge", {
    method: "POST",
    body: JSON.stringify({ survivor_id: survivorId, loser_id: loserId }),
  });
}

export async function undoMerge(user: User, mergeId: number): Promise<void> {
  await apiFetch(user, `/patient-merge/${mergeId}/undo`, { method: "POST" });
}

export interface ApiAuditEntry {
  id: string;
  patient_id: string;
  actor_uid: string;
  actor_email: string;
  action: "create" | "update" | "soft_delete" | "restore";
  changed: { before: ApiPatient | null; after: ApiPatient | null };
  created_at: string;
}

// ---------------------------------------------------------------- audit log
//
// The OpenEMR-style central event log (see
// workspace/marc-innotech/patient-api/schema-events.sql). One row per
// event: patient views, sign-ins, sign-outs, API calls, failed
// sign-ins, and admin actions. Rows carry a tamper-evident hash chain
// (prev_hash + row_hash); GET /events/verify recomputes it.

export type AuditEventName =
  | "patient_view"
  | "sign_in"
  | "sign_out"
  | "report_export"
  | "auth_failure"
  | "api_request"
  | "admin_action"
  | "appointment_change"
  | "message_send"
  | "message_read"
  | "document_create"
  | "document_update"
  | "document_finalize";

export interface ApiEvent {
  id: string;
  seq: string; // int8 arrives as a string
  actor_uid: string;
  actor_email: string;
  event: AuditEventName;
  patient_id: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  created_at: string;
  prev_hash: string | null;
  row_hash: string | null;
}

export interface EventFilters {
  event?: AuditEventName;
  actor_email?: string;
  patient_id?: string;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  limit?: number;
  offset?: number;
}

// List events, newest first, paginated. All filters are optional;
// the server validates them (unknown event names and bad dates are
// rejected with 400, which surfaces here as a thrown error).
export async function listEvents(
  user: User,
  filters: EventFilters = {},
): Promise<ApiEvent[]> {
  const params = new URLSearchParams();
  if (filters.event) params.set("event", filters.event);
  if (filters.actor_email) params.set("actor_email", filters.actor_email);
  if (filters.patient_id) params.set("patient_id", filters.patient_id);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  params.set("limit", String(filters.limit ?? 50));
  params.set("offset", String(filters.offset ?? 0));
  return (await apiFetch(
    user,
    `/events?${params.toString()}`,
  )) as ApiEvent[];
}

export interface ChainVerification {
  table: string;
  total: number;
  legacy: number;
  checked: number;
  valid: boolean;
  first_break: { seq: string; id: string; reason: string } | null;
}

// Recompute both hash chains on the server. The caller shows the
// result as a badge; a broken chain names the first failing row.
export async function verifyChain(
  user: User,
): Promise<Record<string, ChainVerification>> {
  return (await apiFetch(user, "/events/verify")) as Record<
    string,
    ChainVerification
  >;
}

// Report a client-side event. Only sign_in, sign_out, and
// report_export are client-reportable — the server rejects
// server-generated events (patient_view, auth_failure, api_request,
// admin_action) with 400, so the dashboard can never forge them.
// Callers treat failures as best-effort: logging must never break
// sign-in or sign-out.
export async function reportEvent(
  user: User,
  event: "sign_in" | "sign_out" | "report_export",
  details?: Record<string, unknown>,
): Promise<ApiEvent> {
  return (await apiFetch(user, "/events", {
    method: "POST",
    body: JSON.stringify({ event, details: details ?? {} }),
  })) as ApiEvent;
}

// One patient's audit trail, newest first. Works for soft-deleted
// patients too — the trail survives deletion by design.
export async function getPatientAudit(
  user: User,
  id: string,
): Promise<ApiAuditEntry[]> {
  const entries = (await apiFetch(
    user,
    `/patients/${encodeURIComponent(id)}/audit`,
  )) as ApiAuditEntry[];
  return entries.map((e) => ({
    ...e,
    changed: {
      before: e.changed.before
        ? normalizeApiPatient(e.changed.before)
        : null,
      after: e.changed.after ? normalizeApiPatient(e.changed.after) : null,
    },
  }));
}

// ---------------------------------------------------------------- staff
//
// The users table (staff directory) client. Reads are plain
// authenticated calls; every WRITE is gated on the CALLER's staff
// role — the API requires an active manager/admin users row and
// rejects with 403 ROLE_REQUIRED otherwise (the manager PIN was
// retired on 2026-11-02 in favor of role gates). "Delete" is
// a deactivate: the API sets active = false and keeps the row;
// restoreStaff undoes it.

export type StaffRole =
  | "clinician"
  | "manager"
  | "admin"
  | "developer"
  | "support"
  | "billing"
  | "front_office";

export const STAFF_ROLES: { value: StaffRole; label: string }[] = [
  { value: "clinician", label: "Clinician" },
  { value: "manager", label: "Manager" },
  { value: "admin", label: "Admin" },
  { value: "developer", label: "Developer" },
  { value: "support", label: "Support" },
  { value: "billing", label: "Billing" },
  { value: "front_office", label: "Front office" },
];

// Common medical credentials offered in the staff form's
// Suffix / Credential dropdown (Jake, 2026-10-30). Stored in the
// users.suffix field and rendered as part of the card's full name.
// A stored value outside this list is kept as an extra option in
// the dropdown so an edit never silently wipes it (same pattern as
// the StateSelect component).
export const STAFF_CREDENTIALS: string[] = [
  "PT",
  "DPT",
  "PTA",
  "OT",
  "OTR/L",
  "COTA",
  "SLP",
  "RN",
  "BSN",
  "APRN",
  "NP",
  "LPN",
  "CNA",
  "HHA",
  "MSW",
  "LCSW",
  "RD",
  "PharmD",
  "MD",
  "DO",
  "PA",
];

// Common home-health positions offered in the staff form's
// Position dropdown (Jake, 2026-10-30). Stored in the
// users.position field (schema-users-position.sql) and shown
// leading the clinician card's position line. Same safety
// pattern as STAFF_CREDENTIALS: a stored value outside this
// list is kept as an extra option in the dropdown so an edit
// never silently wipes it.
export const STAFF_POSITIONS: string[] = [
  "Physical Therapist",
  "Physical Therapist Assistant",
  "Occupational Therapist",
  "Occupational Therapy Assistant",
  "Speech-Language Pathologist",
  "Registered Nurse",
  "Licensed Practical Nurse",
  "Nurse Practitioner",
  "Home Health Aide",
  "Certified Nursing Assistant",
  "Medical Social Worker",
  "Registered Dietitian",
  "Pharmacist",
  "Physician",
  "Physician Assistant",
  "Clinical Manager",
  "Director of Rehab",
  "Administrator",
  "Intake Coordinator",
  "Scheduler",
  "Office Manager",
  "Billing Specialist",
  "Other",
];

export interface ApiUser {
  id: string; // int8 arrives as a string
  firebase_uid: string | null;
  email: string;
  role: StaffRole;
  authorized: boolean;
  active: boolean;
  fname: string;
  mname: string | null;
  lname: string;
  suffix: string | null;
  title: string | null;
  position: string | null;
  valedictory: string | null;
  npi: string | null;
  taxonomy: string | null;
  specialty: string | null;
  physician_type: string | null;
  state_license_number: string | null;
  facility: string | null;
  facility_id: number | null;
  organization: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  phonecell: string | null;
  fax: string | null;
  info: string | null;
  notes: string | null;
  has_pin: boolean;
  created_at: string;
  updated_at: string;
}

export interface StaffInput {
  email?: string;
  role?: StaffRole;
  authorized?: boolean;
  fname?: string;
  mname?: string | null;
  lname?: string;
  suffix?: string | null;
  title?: string | null;
  position?: string | null;
  specialty?: string | null;
  organization?: string | null;
  npi?: string | null;
  state_license_number?: string | null;
  phone?: string | null;
  phonecell?: string | null;
}

export async function listUsers(user: User): Promise<ApiUser[]> {
  return (await apiFetch(user, "/users")) as ApiUser[];
}

// The signed-in user's own staff record (GET /users/me), or null
// when they have none. The dashboard reads the role to show or
// hide manager-only actions; the API stays the enforcement.
export async function fetchMyStaffRecord(
  user: User,
): Promise<ApiUser | null> {
  return (await apiFetch(user, "/users/me")) as ApiUser | null;
}

// Create a staff member. ROLE-GATED (manager/admin).
export async function createStaff(
  user: User,
  input: StaffInput,
): Promise<ApiUser> {
  return (await apiFetch(user, "/users", {
    method: "POST",
    body: JSON.stringify(input),
  })) as ApiUser;
}

// Update a staff member (partial payloads fine). ROLE-GATED.
export async function updateStaff(
  user: User,
  id: string,
  input: StaffInput,
): Promise<ApiUser> {
  return (await apiFetch(user, `/users/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  })) as ApiUser;
}

// Deactivate a staff member (active = false; the row stays).
// ROLE-GATED.
export async function deactivateStaff(
  user: User,
  id: string,
): Promise<void> {
  await apiFetch(user, `/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// Reactivate a deactivated staff member. ROLE-GATED.
export async function restoreStaff(
  user: User,
  id: string,
): Promise<ApiUser> {
  return (await apiFetch(
    user,
    `/users/${encodeURIComponent(id)}/restore`,
    { method: "POST" },
  )) as ApiUser;
}

// ------------------------------------------------------------------
// Appointments (calendar). Model correlated with OpenEMR: categories
// carry the color + default duration, the provider is a users row,
// statuses come from the API's status list (flow-board order).

export interface AppointmentCategory {
  id: string;
  name: string;
  color: string;
  description: string | null;
  cattype: "appointment" | "provider";
  default_duration_min: number;
  active: boolean;
}

export interface CategoryInput {
  name?: string;
  color?: string;
  cattype?: "appointment" | "provider";
  default_duration_min?: number;
  description?: string | null;
  active?: boolean;
}

export interface AppointmentStatusInfo {
  code: string;
  label: string;
  color: string;
  is_checkin: boolean;
  is_checkout: boolean;
}

export interface ApiAppointment {
  id: string;
  patient_id: string | null;
  patient_name: string | null;
  provider_id: string | null;
  provider_name: string | null;
  category_id: string;
  category_name: string;
  category_color: string;
  cattype: "appointment" | "provider";
  default_duration_min: number;
  title: string;
  starts_at: string;
  ends_at: string;
  status: string;
  room: string | null;
  notes: string | null;
  // Repeating-visits series link (2026-11-02); null for one-offs.
  series_id: string | null;
  // The episode this visit belongs to (platform, 2026-11-03);
  // null for provider-block rows and pre-platform appointments.
  episode_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AppointmentInput {
  patient_id?: string | null;
  provider_id?: string | null;
  category_id: string;
  title?: string;
  starts_at: string;
  ends_at: string;
  status?: string;
  room?: string | null;
  notes?: string | null;
}

export async function listAppointmentCategories(
  user: User,
  all = false,
): Promise<AppointmentCategory[]> {
  const out = (await apiFetch(
    user,
    `/appointments/categories${all ? "?all=1" : ""}`,
  )) as {
    categories: AppointmentCategory[];
  };
  return out.categories;
}

// Category writes are ROLE-GATED (manager/admin) — categories
// are practice configuration, edited from the Settings screen.
export async function createAppointmentCategory(
  user: User,
  input: CategoryInput,
): Promise<AppointmentCategory> {
  const out = (await apiFetch(user, "/appointments/categories", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { category: AppointmentCategory };
  return out.category;
}

export async function updateAppointmentCategory(
  user: User,
  id: string,
  input: CategoryInput,
): Promise<AppointmentCategory> {
  const out = (await apiFetch(
    user,
    `/appointments/categories/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  )) as { category: AppointmentCategory };
  return out.category;
}

export async function deactivateAppointmentCategory(
  user: User,
  id: string,
): Promise<void> {
  await apiFetch(
    user,
    `/appointments/categories/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function restoreAppointmentCategory(
  user: User,
  id: string,
): Promise<AppointmentCategory> {
  const out = (await apiFetch(
    user,
    `/appointments/categories/${encodeURIComponent(id)}/restore`,
    { method: "POST" },
  )) as { category: AppointmentCategory };
  return out.category;
}

export async function listAppointmentStatuses(
  user: User,
): Promise<AppointmentStatusInfo[]> {
  const out = (await apiFetch(user, "/appointments/statuses")) as {
    statuses: AppointmentStatusInfo[];
  };
  return out.statuses;
}

export async function listAppointments(
  user: User,
  fromISO: string,
  toISO: string,
  opts: { patientId?: string; scope?: "all" } = {},
): Promise<ApiAppointment[]> {
  const q = new URLSearchParams({ from: fromISO, to: toISO });
  // Platform scopes (2026-11-03): the default is the caller's
  // personal calendar. patientId asks for the patient's master
  // schedule (every team member's visits — chart access required);
  // scope "all" is the manager/admin practice-wide view.
  if (opts.patientId) q.set("patient_id", opts.patientId);
  if (opts.scope) q.set("scope", opts.scope);
  const out = (await apiFetch(user, `/appointments?${q}`)) as {
    appointments: ApiAppointment[];
  };
  return out.appointments;
}

// Create is NOT gated (front-desk booking, like patient intake).
export async function createAppointment(
  user: User,
  input: AppointmentInput,
): Promise<ApiAppointment> {
  const out = (await apiFetch(user, "/appointments", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { appointment: ApiAppointment };
  return out.appointment;
}

// Update is NOT gated — rescheduling stays frictionless (this is
// what makes drag-to-another-day work without a prompt).
export async function updateAppointment(
  user: User,
  id: string,
  input: Partial<AppointmentInput>,
): Promise<ApiAppointment> {
  const out = (await apiFetch(
    user,
    `/appointments/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  )) as { appointment: ApiAppointment };
  return out.appointment;
}

// Status-only change — NOT gated (flow-board check-in pattern).
export async function setAppointmentStatus(
  user: User,
  id: string,
  status: string,
): Promise<ApiAppointment> {
  const out = (await apiFetch(
    user,
    `/appointments/${encodeURIComponent(id)}/status`,
    { method: "POST", body: JSON.stringify({ status }) },
  )) as { appointment: ApiAppointment };
  return out.appointment;
}

// Soft delete. ROLE-GATED (manager/admin). With scope "series"
// every live member of the appointment's series is deleted in
// the same act (2026-11-02).
export async function deleteAppointment(
  user: User,
  id: string,
  scope?: "series",
): Promise<void> {
  const q = scope === "series" ? "?scope=series" : "";
  await apiFetch(user, `/appointments/${encodeURIComponent(id)}${q}`, {
    method: "DELETE",
  });
}

// ---- Appointment series (2026-11-02) --------------------------
// The dashboard computes the visit start times (the staggered
// phase builder lives in CalendarView); the API creates them in
// one transaction under one series_id.

export interface AppointmentSeriesInput extends AppointmentInput {
  duration_min: number;
  visits: string[]; // ISO start times, one per visit
}

export async function createAppointmentSeries(
  user: User,
  input: AppointmentSeriesInput,
): Promise<{ series_id: string; appointments: ApiAppointment[] }> {
  return (await apiFetch(user, "/appointments/series", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { series_id: string; appointments: ApiAppointment[] };
}

// Series-wide field edit (category / provider / title / room /
// notes) — NOT gated, like the single-appointment PUT. Dates
// and times are per-visit and are not touched.
export async function updateAppointmentSeries(
  user: User,
  seriesId: string,
  input: Partial<AppointmentInput>,
): Promise<ApiAppointment[]> {
  const out = (await apiFetch(
    user,
    `/appointments/series/${encodeURIComponent(seriesId)}`,
    { method: "PUT", body: JSON.stringify(input) },
  )) as { appointments: ApiAppointment[] };
  return out.appointments;
}

// ------------------------------------------------------------------
// Agencies (IDPH directory). The agencies table mirrors the IDPH
// Home Health Agency Directory (Illinois open data, Socrata
// dataset p7mg-cnpx), synced server-side by the API / the weekly
// timer. Reads are open to signed-in staff; every write is a
// LOCAL field (is_primary / notes / short_name) behind the
// manager/admin role, and "Sync now" is role-gated too. display_name is
// computed by the API (short_name → embedded DBA → first two
// words → full name); name is always the full legal name.

export interface ApiAgency {
  id: number;
  license_number: string;
  name: string;
  dba: string | null;
  display_name: string;
  street: string | null;
  city: string | null;
  state: string;
  postal_code: string | null;
  county: string | null;
  phone: string | null;
  admin_contact_name: string | null;
  license_expiration_date: string | null;
  source: string;
  active: boolean;
  is_primary: boolean;
  notes: string | null;
  short_name: string | null;
  // CMS enrichment (schema-agencies-cms.sql): matched from the
  // CMS "Home Health Care Agencies" dataset; all null when the
  // agency has no CMS match. star_rating arrives as a string
  // from Postgres NUMERIC (occasionally a number) — parse it.
  ccn: string | null;
  offers_nursing: boolean | null;
  offers_pt: boolean | null;
  offers_ot: boolean | null;
  offers_speech: boolean | null;
  offers_msw: boolean | null;
  offers_hha: boolean | null;
  star_rating: string | number | null;
  cms_ownership: string | null;
  cms_cert_date: string | null;
  cms_matched_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgencySyncSummary {
  fetched: number;
  inserted: number;
  updated: number;
  deactivated: number;
  skipped_no_change: number;
  source_updated_at: string | null;
  trigger: string;
  cms_rows?: number;
  cms_matched?: number;
  cms_unmatched?: number;
  cms_error?: string;
}

export interface AgencySyncStatus {
  last_run_at: string;
  fetched: number;
  inserted: number;
  updated: number;
  deactivated: number;
  skipped_no_change: number;
  source_updated_at: string | null;
  trigger: string;
  cms_rows?: number;
  cms_matched?: number;
  cms_unmatched?: number;
  cms_error?: string;
}

export type AgencyServiceKey =
  | "nursing"
  | "pt"
  | "ot"
  | "speech"
  | "msw"
  | "hha";

export async function fetchAgencies(
  user: User,
  opts: {
    q?: string;
    active?: boolean;
    service?: AgencyServiceKey[];
    minRating?: number;
  } = {},
): Promise<ApiAgency[]> {
  const token = await user.getIdToken();
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.active !== undefined) params.set("active", String(opts.active));
  if (opts.service && opts.service.length) {
    params.set("service", opts.service.join(","));
  }
  if (opts.minRating !== undefined) {
    params.set("min_rating", String(opts.minRating));
  }
  params.set("limit", "1000");
  const qs = params.toString();
  const res = await fetch(`${apiBase()}/agencies${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`agencies list failed: ${res.status}`);
  const rows = (await res.json()) as ApiAgency[];
  return rows.map(normalizeApiAgency);
}

export async function fetchPrimaryAgency(
  user: User,
): Promise<ApiAgency | null> {
  const token = await user.getIdToken();
  const res = await fetch(`${apiBase()}/agencies/primary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`primary agency failed: ${res.status}`);
  const row = (await res.json()) as ApiAgency | null;
  return row ? normalizeApiAgency(row) : null;
}

export async function fetchAgencySyncStatus(
  user: User,
): Promise<AgencySyncStatus | null> {
  const token = await user.getIdToken();
  const res = await fetch(`${apiBase()}/agencies/sync-status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`agency sync status failed: ${res.status}`);
  return (await res.json()) as AgencySyncStatus | null;
}

export async function updateAgency(
  user: User,
  id: number,
  fields: {
    is_primary?: boolean;
    notes?: string | null;
    short_name?: string | null;
  },
): Promise<ApiAgency> {
  const token = await user.getIdToken();
  const res = await fetch(`${apiBase()}/agencies/${id}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw Object.assign(
      new Error(data.error ?? `update agency failed: ${res.status}`),
      { code: data.code, status: res.status },
    );
  }
  return normalizeApiAgency((await res.json()) as ApiAgency);
}

export async function syncAgenciesNow(
  user: User,
): Promise<AgencySyncSummary> {
  const token = await user.getIdToken();
  const res = await fetch(`${apiBase()}/agencies/sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw Object.assign(
      new Error(data.error ?? `agency sync failed: ${res.status}`),
      { code: data.code, status: res.status },
    );
  }
  return (await res.json()) as AgencySyncSummary;
}

// ------------------------------------------------------------------
// Clinical documents. OpenEMR encounter-forms pattern: Evaluation,
// Reassessment, and Discharge templates (see documentTemplates.ts)
// tied to a patient, optionally to an appointment. Sections are a
// Record of section key → text. Drafts are editable; finalizing
// locks the document (the API rejects further edits with
// DOCUMENT_FINALIZED). Update and finalize are NOT gated;
// delete and restore are ROLE-GATED (manager/admin) like
// patient delete.

export type DocStatus = "draft" | "finalized";

export interface ApiDocument {
  id: string;
  patient_id: string;
  patient_name: string | null;
  appointment_id: string | null;
  author_id: string;
  author_name: string;
  author_email: string;
  doc_type: DocType;
  title: string | null;
  sections: Record<string, string>;
  status: DocStatus;
  finalized_at: string | null;
  finalized_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DocumentInput {
  patient_id: string;
  doc_type: DocType;
  title?: string | null;
  sections?: Record<string, string>;
  appointment_id?: string | null;
}

export async function listDocuments(
  user: User,
  patientId: string,
): Promise<ApiDocument[]> {
  const params = new URLSearchParams({ patient_id: patientId });
  const out = (await apiFetch(
    user,
    `/documents?${params.toString()}`,
  )) as { documents: ApiDocument[] };
  return out.documents;
}

export async function getDocument(
  user: User,
  id: string,
): Promise<ApiDocument> {
  const out = (await apiFetch(
    user,
    `/documents/${encodeURIComponent(id)}`,
  )) as { document: ApiDocument };
  return out.document;
}

export async function createDocument(
  user: User,
  input: DocumentInput,
): Promise<ApiDocument> {
  const out = (await apiFetch(user, "/documents", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { document: ApiDocument };
  return out.document;
}

// Update a draft document (not gated). The API rejects edits to
// a finalized document with code DOCUMENT_FINALIZED.
export async function updateDocument(
  user: User,
  id: string,
  input: {
    title?: string | null;
    sections?: Record<string, string>;
    appointment_id?: string | null;
  },
): Promise<ApiDocument> {
  const out = (await apiFetch(
    user,
    `/documents/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  )) as { document: ApiDocument };
  return out.document;
}

// Finalize a document — locks it against further edits.
export async function finalizeDocument(
  user: User,
  id: string,
): Promise<ApiDocument> {
  const out = (await apiFetch(
    user,
    `/documents/${encodeURIComponent(id)}/finalize`,
    { method: "POST" },
  )) as { document: ApiDocument };
  return out.document;
}

// Soft-delete a document (the API keeps the row, sets deleted_at).
// ROLE-GATED (manager/admin).
export async function deleteDocument(
  user: User,
  id: string,
): Promise<void> {
  await apiFetch(user, `/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// Undo a soft delete (the API clears deleted_at). ROLE-GATED,
// same as deleteDocument.
export async function restoreDocument(
  user: User,
  id: string,
): Promise<ApiDocument> {
  const out = (await apiFetch(
    user,
    `/documents/${encodeURIComponent(id)}/restore`,
    { method: "POST" },
  )) as { document: ApiDocument };
  return out.document;
}

// ------------------------------------------------------------------
// Multi-user platform (2026-11-03): master patient registry with
// per-user lists (patient_links), episodes as the unit of sharing,
// episode teams, agency memberships, and invite-only sign-up.
// Spec: ~/workspace/marc-innotech/multi-user-platform-spec.md.
// The API's staff-record gate replaced the email allowlist: a
// signed-in user with no staff record gets 403 NO_STAFF_RECORD
// from every route except POST /invites/accept.

// ---- Colleagues -------------------------------------------------
// The provider directory for THIS caller: themselves plus the
// staff who share at least one agency membership (platform admins
// see everyone). This is what booking dropdowns and episode-team
// pickers use — NOT the full staff list.
export async function listClinicians(user: User): Promise<ApiUser[]> {
  return (await apiFetch(user, "/users/clinicians")) as ApiUser[];
}

// ---- Patient links (my list) ------------------------------------

// Add a registry patient to the caller's list (idempotent; revives
// a removed link as active). This is the "Add to my list" act
// behind the duplicate block.
export async function linkPatient(
  user: User,
  patientId: string,
): Promise<{ linked: boolean; list_status: PatientStatus }> {
  return (await apiFetch(
    user,
    `/patients/${encodeURIComponent(patientId)}/link`,
    { method: "POST" },
  )) as { linked: boolean; list_status: PatientStatus };
}

// Remove a patient from the caller's list. The registry record and
// its history stay; the caller loses chart access unless an
// episode team or a coverage visit still connects them.
export async function unlinkPatient(
  user: User,
  patientId: string,
): Promise<void> {
  await apiFetch(user, `/patients/${encodeURIComponent(patientId)}/link`, {
    method: "DELETE",
  });
}

// Set the caller's own list status for a patient (active / hold /
// discharged). Per-user by design: my "discharged" never touches
// a colleague's list.
export async function setLinkStatus(
  user: User,
  patientId: string,
  listStatus: PatientStatus,
): Promise<{ linked: boolean; list_status: PatientStatus }> {
  return (await apiFetch(
    user,
    `/patients/${encodeURIComponent(patientId)}/link`,
    { method: "PUT", body: JSON.stringify({ list_status: listStatus }) },
  )) as { linked: boolean; list_status: PatientStatus };
}

// ---- Episodes ----------------------------------------------------

export interface ApiEpisodeMember {
  user_id: string;
  user_name: string;
  user_role: string;
  user_position: string | null;
  member_role: "primary" | "member";
  supervised_by: string | null;
  supervised_by_name: string | null;
  added_at: string;
  removed_at: string | null;
}

export interface ApiEpisodeHold {
  reason: string;
  note: string | null;
  started_on: string;
}

export interface ApiEpisode {
  id: string;
  patient_id: string;
  agency_id: number;
  agency_name: string;
  primary_user_id: string;
  primary_name: string;
  // The clinical coordinator of the case (addendum 2026-11-03);
  // defaults to the primary, transferable to any team member.
  case_manager_user_id: string | null;
  case_manager_name: string | null;
  status: "active" | "on_hold" | "discharged";
  admitted_at: string;
  discharged_at: string | null;
  discharge_reason: string | null;
  discharge_note: string | null;
  recert_of: string | null;
  created_by: string;
  created_at: string;
  members: ApiEpisodeMember[];
  // Present on on_hold episodes: the current open hold.
  current_hold?: ApiEpisodeHold | null;
}

// Hold + discharge reason vocabularies (mirror the API CHECKs),
// with the labels the UI shows.
export const HOLD_REASONS: { value: string; label: string }[] = [
  { value: "hospitalized", label: "Hospitalized" },
  { value: "patient_request", label: "Patient request" },
  { value: "physician_order", label: "Physician order" },
  { value: "other", label: "Other" },
];

export const DISCHARGE_REASONS: { value: string; label: string }[] = [
  { value: "completed", label: "Goals met — care complete" },
  { value: "patient_declined", label: "Patient / family declined" },
  { value: "transferred_agency", label: "Transferred to another agency" },
  { value: "transferred_inpatient", label: "Transferred to inpatient facility" },
  { value: "moved_out_of_area", label: "Moved out of the service area" },
  { value: "physician_order", label: "Physician ordered stop" },
  { value: "deceased", label: "Deceased" },
  { value: "other", label: "Other" },
];

export function holdReasonLabel(value: string | null | undefined): string {
  return HOLD_REASONS.find((r) => r.value === value)?.label ?? "On hold";
}

export function dischargeReasonLabel(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  return DISCHARGE_REASONS.find((r) => r.value === value)?.label ?? value;
}

// All episodes for a patient, newest first, each with its team.
// Chart access required (the API answers 404 otherwise).
export async function fetchEpisodes(
  user: User,
  patientId: string,
): Promise<ApiEpisode[]> {
  const out = (await apiFetch(
    user,
    `/patients/${encodeURIComponent(patientId)}/episodes`,
  )) as { episodes: ApiEpisode[] };
  return out.episodes;
}

// Open an episode at one of the caller's agencies. The caller
// becomes the primary. 409 EPISODE_ACTIVE when any agency already
// holds an active episode for this patient — the error body names
// the holding agency and primary.
export async function createEpisode(
  user: User,
  patientId: string,
  agencyId: number,
  admittedAt?: string,
): Promise<ApiEpisode> {
  const out = (await apiFetch(
    user,
    `/patients/${encodeURIComponent(patientId)}/episodes`,
    {
      method: "POST",
      body: JSON.stringify({
        agency_id: agencyId,
        ...(admittedAt ? { admitted_at: admittedAt } : {}),
      }),
    },
  )) as { episode: ApiEpisode };
  return out.episode;
}

export async function dischargeEpisode(
  user: User,
  episodeId: string,
  opts: { dischargedAt?: string; note?: string; reason?: string } = {},
): Promise<ApiEpisode> {
  const out = (await apiFetch(
    user,
    `/episodes/${encodeURIComponent(episodeId)}/discharge`,
    {
      method: "POST",
      body: JSON.stringify({
        ...(opts.dischargedAt ? { discharged_at: opts.dischargedAt } : {}),
        ...(opts.reason ? { discharge_reason: opts.reason } : {}),
        ...(opts.note ? { discharge_note: opts.note } : {}),
      }),
    },
  )) as { episode: ApiEpisode };
  return out.episode;
}

// Put an episode on hold (addendum 2026-11-03): the episode stays
// live — it still owns the patient — but booking closes until the
// hold ends. Reason defaults to "other" server-side.
export async function holdEpisode(
  user: User,
  episodeId: string,
  opts: { reason?: string; note?: string; startedOn?: string } = {},
): Promise<ApiEpisode> {
  const out = (await apiFetch(
    user,
    `/episodes/${encodeURIComponent(episodeId)}/hold`,
    {
      method: "POST",
      body: JSON.stringify({
        ...(opts.reason ? { reason: opts.reason } : {}),
        ...(opts.note ? { note: opts.note } : {}),
        ...(opts.startedOn ? { started_on: opts.startedOn } : {}),
      }),
    },
  )) as { episode: ApiEpisode };
  return out.episode;
}

// End the current hold; the episode goes back to active.
export async function resumeEpisode(
  user: User,
  episodeId: string,
  resumedOn?: string,
): Promise<ApiEpisode> {
  const out = (await apiFetch(
    user,
    `/episodes/${encodeURIComponent(episodeId)}/resume`,
    {
      method: "POST",
      body: JSON.stringify({
        ...(resumedOn ? { resumed_on: resumedOn } : {}),
      }),
    },
  )) as { episode: ApiEpisode };
  return out.episode;
}

// Same-agency recertification: closes this episode and opens its
// successor with the same team, in one act.
export async function recertifyEpisode(
  user: User,
  episodeId: string,
  admittedAt?: string,
): Promise<ApiEpisode> {
  const out = (await apiFetch(
    user,
    `/episodes/${encodeURIComponent(episodeId)}/recertify`,
    {
      method: "POST",
      body: JSON.stringify({
        ...(admittedAt ? { admitted_at: admittedAt } : {}),
      }),
    },
  )) as { episode: ApiEpisode };
  return out.episode;
}

// Add a colleague to the episode team (they must belong to the
// episode's agency; the patient is auto-linked to their list).
// Returns the episode's full member list.
export async function addEpisodeMember(
  user: User,
  episodeId: string,
  input: { userId: string; supervisedBy?: string | null },
): Promise<ApiEpisodeMember[]> {
  const out = (await apiFetch(
    user,
    `/episodes/${encodeURIComponent(episodeId)}/members`,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: input.userId,
        ...(input.supervisedBy
          ? { supervised_by: input.supervisedBy }
          : {}),
      }),
    },
  )) as { members: ApiEpisodeMember[] };
  return out.members;
}

export async function removeEpisodeMember(
  user: User,
  episodeId: string,
  memberUserId: string,
): Promise<ApiEpisodeMember[]> {
  const out = (await apiFetch(
    user,
    `/episodes/${encodeURIComponent(episodeId)}/members/${encodeURIComponent(memberUserId)}`,
    { method: "DELETE" },
  )) as { members: ApiEpisodeMember[] };
  return out.members;
}

// Hand the primary role to another current team member.
export async function transferEpisodePrimary(
  user: User,
  episodeId: string,
  newPrimaryUserId: string,
): Promise<ApiEpisode> {
  const out = (await apiFetch(
    user,
    `/episodes/${encodeURIComponent(episodeId)}/primary`,
    {
      method: "PUT",
      body: JSON.stringify({ user_id: newPrimaryUserId }),
    },
  )) as { episode: ApiEpisode };
  return out.episode;
}

// Hand case management to another current team member
// (addendum 2026-11-03). The case manager runs the case
// clinically and holds full episode management rights.
export async function transferCaseManager(
  user: User,
  episodeId: string,
  newCaseManagerUserId: string,
): Promise<ApiEpisode> {
  const out = (await apiFetch(
    user,
    `/episodes/${encodeURIComponent(episodeId)}/case-manager`,
    {
      method: "PUT",
      body: JSON.stringify({ user_id: newCaseManagerUserId }),
    },
  )) as { episode: ApiEpisode };
  return out.episode;
}

// ---- My agencies --------------------------------------------------
// The agencies the caller belongs to. Membership is what lets a
// clinician open episodes, join teams, and take coverage visits
// at an agency.

// The /users/me/agencies route returns a light row (id, legal
// name, display name, city, state) — not the full directory row.
export interface ApiMyAgency {
  id: number;
  name: string;
  display_name: string;
  city: string | null;
  state: string | null;
}

export async function fetchMyAgencies(user: User): Promise<ApiMyAgency[]> {
  const out = (await apiFetch(user, "/users/me/agencies")) as {
    agencies: ApiMyAgency[];
  };
  return out.agencies.map((a) => ({ ...a, id: Number(a.id) }));
}

export async function addMyAgency(
  user: User,
  agencyId: number,
): Promise<void> {
  await apiFetch(user, "/users/me/agencies", {
    method: "POST",
    body: JSON.stringify({ agency_id: agencyId }),
  });
}

// 409 PRIMARY_ON_ACTIVE_EPISODE when the caller is the primary on
// an active episode at that agency — discharge or transfer first.
export async function removeMyAgency(
  user: User,
  agencyId: number,
): Promise<void> {
  await apiFetch(user, `/users/me/agencies/${agencyId}`, {
    method: "DELETE",
  });
}

// ---- Invites ------------------------------------------------------

export interface ApiInvite {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  invited_by: string;
  expires_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: string;
}

// Create an invite (platform admin only). The raw code comes back
// exactly once — build the acceptance link from it immediately.
export async function createInvite(
  user: User,
  input: { email: string; role: string },
): Promise<{ invite: ApiInvite; code: string; accept_path: string }> {
  return (await apiFetch(user, "/invites", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { invite: ApiInvite; code: string; accept_path: string };
}

export async function listInvites(user: User): Promise<ApiInvite[]> {
  const out = (await apiFetch(user, "/invites")) as {
    invites: ApiInvite[];
  };
  return out.invites;
}

export async function revokeInvite(
  user: User,
  inviteId: string,
): Promise<ApiInvite> {
  const out = (await apiFetch(
    user,
    `/invites/${encodeURIComponent(inviteId)}`,
    { method: "DELETE" },
  )) as { invite: ApiInvite };
  return out.invite;
}

// Accept an invite with a freshly signed-in account: creates (or
// claims) the caller's staff record with the invite's role. This
// is the one platform route open to a user with no staff record.
// Error codes: INVITE_INVALID / INVITE_USED / INVITE_EXPIRED /
// INVITE_EMAIL_MISMATCH.
export async function acceptInvite(
  user: User,
  input: { code: string; fname?: string; lname?: string },
): Promise<ApiUser> {
  const out = (await apiFetch(user, "/invites/accept", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { staff: ApiUser };
  return out.staff;
}

// ---------------------------------------------------------------------------
// Phone contacts sync (CardDAV) — per-clinician self-service.
// The password is returned ONCE by enable / regenerate and is
// never stored in the API database. See
// carddav-contacts-sync-spec.md.
// ---------------------------------------------------------------------------

export interface ContactSyncStatus {
  configured: boolean;
  enabled: boolean;
  dav_username: string | null;
  server_url: string;
  book_name: string;
  last_sync_at: string | null;
  last_result: string | null;
  contact_count: number;
}

export interface ContactSyncCredentials {
  dav_username: string;
  password: string;
  server_url?: string;
  book_name?: string;
  sync?: { created?: number; updated?: number; deleted?: number; total?: number; error?: string; skipped?: string };
}

export async function fetchContactSync(user: User): Promise<ContactSyncStatus> {
  return (await apiFetch(user, "/contact-sync/me")) as ContactSyncStatus;
}

export async function enableContactSync(user: User): Promise<ContactSyncCredentials> {
  return (await apiFetch(user, "/contact-sync/me/enable", {
    method: "POST",
  })) as ContactSyncCredentials;
}

export async function regenerateContactSyncPassword(user: User): Promise<ContactSyncCredentials> {
  return (await apiFetch(user, "/contact-sync/me/regenerate-password", {
    method: "POST",
  })) as ContactSyncCredentials;
}

export async function syncContactsNow(user: User): Promise<ContactSyncCredentials["sync"]> {
  const out = (await apiFetch(user, "/contact-sync/me/sync-now", {
    method: "POST",
  })) as { sync: ContactSyncCredentials["sync"] };
  return out.sync;
}

export async function disableContactSync(user: User): Promise<void> {
  await apiFetch(user, "/contact-sync/me", { method: "DELETE" });
}
