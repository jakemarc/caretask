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
    // Surface the API's error code (e.g. PIN_REQUIRED / PIN_INVALID on
    // manager-gated writes) alongside the status, so callers can react
    // specifically instead of treating every failure as a dead API.
    let code: string | undefined;
    try {
      const body = (await res.json()) as { code?: string } | null;
      code = body?.code;
    } catch {
      // Non-JSON error body — status alone will have to do.
    }
    const err = new Error(
      `patient API request failed: ${res.status}`,
    ) as ApiRequestError;
    err.status = res.status;
    err.code = code;
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
}

// True when the API rejected a manager-gated write over its PIN
// (missing or incorrect). Callers use this to send the user back to
// the PIN prompt instead of reporting a generic save failure.
export function isPinRejection(err: unknown): boolean {
  const e = err as ApiRequestError | null;
  return e?.code === "PIN_REQUIRED" || e?.code === "PIN_INVALID";
}

// Check a manager PIN against the API (POST /users/verify-pin). The
// PIN itself is verified SERVER-side against the stored hash — the
// dashboard never holds a PIN to compare against. Resolves with the
// authorizing manager's identity; rejects with a 403 ApiRequestError
// when no active manager/admin has that PIN.
export async function verifyManagerPin(
  user: User,
  pin: string,
): Promise<{ id: number; email: string; role: string; name: string }> {
  const out = (await apiFetch(user, "/users/verify-pin", {
    method: "POST",
    body: JSON.stringify({ pin }),
  })) as {
    ok: boolean;
    manager: { id: number; email: string; role: string; name: string };
  };
  return out.manager;
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
// are fine — fields not sent keep their stored values. MANAGER-GATED:
// the API requires a valid manager PIN in the X-Manager-Pin header
// and rejects with 403 PIN_REQUIRED / PIN_INVALID without one.
export async function updatePatient(
  user: User,
  id: string,
  input: Partial<NewApiPatient>,
  pin: string,
): Promise<PersonUnderCare> {
  const row = (await apiFetch(
    user,
    `/patients/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "X-Manager-Pin": pin },
      body: JSON.stringify(input),
    },
  )) as ApiPatient;
  return toPersonUnderCare(row);
}

// Soft-delete a patient (the API keeps the row, sets deleted_at).
// MANAGER-GATED, same as updatePatient.
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
  pin: string,
): Promise<void> {
  await apiFetch(user, `/patients/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Manager-Pin": pin },
  });
}

// Undo a soft delete (the API clears deleted_at). MANAGER-GATED,
// same as updatePatient.
export async function restorePatient(
  user: User,
  id: string,
  pin: string,
): Promise<PersonUnderCare> {
  const row = (await apiFetch(
    user,
    `/patients/${encodeURIComponent(id)}/restore`,
    { method: "POST", headers: { "X-Manager-Pin": pin } },
  )) as ApiPatient;
  return toPersonUnderCare(row);
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
// authenticated calls; every WRITE is manager-gated exactly like
// patient edit/delete — the caller passes the verified manager PIN
// and the API re-checks it server-side (X-Manager-Pin). "Delete" is
// a deactivate: the API sets active = false and keeps the row;
// restoreStaff undoes it. pin_hash is never returned by the API —
// rows carry has_pin instead. A write may carry `pin` in the input
// to SET that staff member's own PIN (hashed server-side).

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
  pin?: string; // set/replace this member's own PIN (write-only)
}

export async function listUsers(user: User): Promise<ApiUser[]> {
  return (await apiFetch(user, "/users")) as ApiUser[];
}

// Create a staff member. MANAGER-GATED (PIN in the header).
export async function createStaff(
  user: User,
  input: StaffInput,
  pin: string,
): Promise<ApiUser> {
  return (await apiFetch(user, "/users", {
    method: "POST",
    headers: { "X-Manager-Pin": pin },
    body: JSON.stringify(input),
  })) as ApiUser;
}

// Update a staff member (partial payloads fine). MANAGER-GATED.
export async function updateStaff(
  user: User,
  id: string,
  input: StaffInput,
  pin: string,
): Promise<ApiUser> {
  return (await apiFetch(user, `/users/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "X-Manager-Pin": pin },
    body: JSON.stringify(input),
  })) as ApiUser;
}

// Deactivate a staff member (active = false; the row stays).
// MANAGER-GATED.
export async function deactivateStaff(
  user: User,
  id: string,
  pin: string,
): Promise<void> {
  await apiFetch(user, `/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Manager-Pin": pin },
  });
}

// Reactivate a deactivated staff member. MANAGER-GATED.
export async function restoreStaff(
  user: User,
  id: string,
  pin: string,
): Promise<ApiUser> {
  return (await apiFetch(
    user,
    `/users/${encodeURIComponent(id)}/restore`,
    { method: "POST", headers: { "X-Manager-Pin": pin } },
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

// Category writes are MANAGER-GATED (PIN in the header) — categories
// are practice configuration, edited from the Settings screen.
export async function createAppointmentCategory(
  user: User,
  input: CategoryInput,
  pin: string,
): Promise<AppointmentCategory> {
  const out = (await apiFetch(user, "/appointments/categories", {
    method: "POST",
    headers: { "X-Manager-Pin": pin },
    body: JSON.stringify(input),
  })) as { category: AppointmentCategory };
  return out.category;
}

export async function updateAppointmentCategory(
  user: User,
  id: string,
  input: CategoryInput,
  pin: string,
): Promise<AppointmentCategory> {
  const out = (await apiFetch(
    user,
    `/appointments/categories/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "X-Manager-Pin": pin },
      body: JSON.stringify(input),
    },
  )) as { category: AppointmentCategory };
  return out.category;
}

export async function deactivateAppointmentCategory(
  user: User,
  id: string,
  pin: string,
): Promise<void> {
  await apiFetch(
    user,
    `/appointments/categories/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: { "X-Manager-Pin": pin } },
  );
}

export async function restoreAppointmentCategory(
  user: User,
  id: string,
  pin: string,
): Promise<AppointmentCategory> {
  const out = (await apiFetch(
    user,
    `/appointments/categories/${encodeURIComponent(id)}/restore`,
    { method: "POST", headers: { "X-Manager-Pin": pin } },
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
): Promise<ApiAppointment[]> {
  const q = new URLSearchParams({ from: fromISO, to: toISO });
  const out = (await apiFetch(user, `/appointments?${q}`)) as {
    appointments: ApiAppointment[];
  };
  return out.appointments;
}

// Create is NOT PIN-gated (front-desk booking, like patient intake).
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

// Update is MANAGER-GATED (PIN in the header).
export async function updateAppointment(
  user: User,
  id: string,
  input: Partial<AppointmentInput>,
  pin: string,
): Promise<ApiAppointment> {
  const out = (await apiFetch(
    user,
    `/appointments/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "X-Manager-Pin": pin },
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

// Soft delete. MANAGER-GATED.
export async function deleteAppointment(
  user: User,
  id: string,
  pin: string,
): Promise<void> {
  await apiFetch(user, `/appointments/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Manager-Pin": pin },
  });
}

// ------------------------------------------------------------------
// Agencies (IDPH directory). The agencies table mirrors the IDPH
// Home Health Agency Directory (Illinois open data, Socrata
// dataset p7mg-cnpx), synced server-side by the API / the weekly
// timer. Reads are open to signed-in staff; every write is a
// LOCAL field (is_primary / notes / short_name) behind the
// manager PIN, and "Sync now" is PIN-gated too. display_name is
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
  pin: string,
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
      "X-Manager-Pin": pin,
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
  pin: string,
): Promise<AgencySyncSummary> {
  const token = await user.getIdToken();
  const res = await fetch(`${apiBase()}/agencies/sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Manager-Pin": pin,
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
// DOCUMENT_FINALIZED). Update and finalize are NOT PIN-gated;
// delete and restore are MANAGER-GATED like patient delete.

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

// Update a draft document (NOT PIN-gated). The API rejects edits to
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
// MANAGER-GATED.
export async function deleteDocument(
  user: User,
  id: string,
  pin: string,
): Promise<void> {
  await apiFetch(user, `/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Manager-Pin": pin },
  });
}

// Undo a soft delete (the API clears deleted_at). MANAGER-GATED,
// same as deleteDocument.
export async function restoreDocument(
  user: User,
  id: string,
  pin: string,
): Promise<ApiDocument> {
  const out = (await apiFetch(
    user,
    `/documents/${encodeURIComponent(id)}/restore`,
    { method: "POST", headers: { "X-Manager-Pin": pin } },
  )) as { document: ApiDocument };
  return out.document;
}
