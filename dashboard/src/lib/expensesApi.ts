// Mileage API client (rewritten 2026-11-02 for the day-chain
// simplification — no approval process).
//
// Model: mileage is a per-clinician DAY LOG of legs. A day's
// legs in seq order form a chain: 'commute' legs are the fixed
// home<->office bookends (personal miles); 'business' legs are
// billable. Reports are GENERATED over any date range with an
// optional agency filter (GET /mileage/report). The old report
// envelopes are legacy read-only on the API and unused here.
//
// Mirrors patientApi.ts's fetch discipline (Firebase ID token,
// status + API error code surfaced on the thrown error). Types
// follow the API's normalization: ids and NUMERICs arrive as
// numbers, DATEs as 'YYYY-MM-DD' strings.
import type { User } from "firebase/auth";
import { apiBase } from "./patientApi";

export interface MileageEntry {
  id: number;
  expense_report_id: number | null;
  user_id: number | null;
  agency_id: number | null;
  entry_date: string;
  seq: number;
  entry_kind: "business" | "commute";
  start_label: string | null;
  start_address: string | null;
  end_label: string | null;
  end_address: string | null;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  appointment_id: number | null;
  patient_id: string | null;
  miles_toll: number | null;
  miles_no_toll: number | null;
  used_tollway: boolean;
  round_trip: boolean;
  business_miles: number;
  rate_per_mile: number | null;
  vehicle: string | null;
  notes: string | null;
  deleted_at: string | null;
  // Deploy-41: attached receipt count (optional so other
  // construction sites for this shape keep compiling).
  receipt_count?: number;
}

export interface MileageInput {
  entry_date: string;
  seq: number;
  entry_kind: "business" | "commute";
  start_label?: string | null;
  start_address?: string | null;
  end_label?: string | null;
  end_address?: string | null;
  start_lat?: number | null;
  start_lng?: number | null;
  end_lat?: number | null;
  end_lng?: number | null;
  appointment_id?: number | null;
  patient_id?: string | null;
  agency_id?: number | null;
  miles_toll?: number | null;
  miles_no_toll?: number | null;
  used_tollway?: boolean;
  round_trip?: boolean;
  business_miles: number;
  rate_per_mile?: number | null;
  vehicle?: string | null;
  notes?: string | null;
}

export interface MileageReportDay {
  date: string;
  legs: MileageEntry[];
  billable_miles: number;
  personal_miles: number;
  driven_miles: number;
  amount_cents: number;
}

// ---------- deploy-41: receipts, rates, policy, itemized lines ----------

export interface ReceiptMeta {
  id: number;
  mileage_entry_id: number | null;
  expense_id: number | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface MileageRate {
  id: number;
  rate: number;
  effective_from: string;
  effective_to: string | null;
  created_by: number | null;
  created_at: string;
}

export interface ExpensePolicy {
  require_receipts: boolean;
  receipt_threshold_cents: number | null;
}

export type ExpenseCategory = "tolls" | "parking" | "meals" | "supplies" | "other";

export const EXPENSE_CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: "tolls", label: "Tolls" },
  { value: "parking", label: "Parking" },
  { value: "meals", label: "Meals" },
  { value: "supplies", label: "Supplies" },
  { value: "other", label: "Other" },
];

// Display label for a stored category value; unknown legacy
// values title-case the raw string.
export function expenseCategoryLabel(value: string | null | undefined): string {
  if (!value) return "Other";
  const known = EXPENSE_CATEGORIES.find((c) => c.value === value);
  if (known) return known.label;
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export interface ExpenseLine {
  id: number;
  report_id: number | null;
  user_id: number | string | null;
  expense_date: string;
  category: string;
  description: string | null;
  vendor_name: string | null;
  amount_cents: number;
  currency: string;
  agency_id: number | null;
  notes: string | null;
  receipt_count: number;
  deleted_at: string | null;
}

export interface ExpenseLineInput {
  expense_date: string;
  category: string;
  description?: string | null;
  vendor_name?: string | null;
  amount_cents: number;
  agency_id?: number | null;
  notes?: string | null;
}

export interface ReceiptViolation {
  kind: "mileage" | "expense";
  id: number;
  date: string;
}

export type ReportStatus = "draft" | "submitted" | "approved" | "rejected" | "paid";

export interface SavedReport {
  id: number;
  user_id: number | string | null;
  period_start: string;
  period_end: string;
  agency_id: number | null;
  title: string | null;
  notes: string | null;
  model: "legacy" | "chain";
  status: ReportStatus | string;
  submitted_at: string | null;
  approved_by: number | string | null;
  approved_at: string | null;
  paid_at: string | null;
  payment_ref: string | null;
  total_billable_miles?: number | null;
  total_personal_miles?: number | null;
  total_driven_miles?: number | null;
  mileage_amount_cents?: number | null;
  expenses_amount_cents?: number | null;
  total_amount_cents?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface ReportEvent {
  id: number;
  from_status: string | null;
  to_status: string;
  actor_id: number | string | null;
  actor_name: string | null;
  note: string | null;
  created_at: string;
}

// GET /expense-reports/:id — chain reports carry the generated
// report's day shape plus itemized lines and grand totals;
// legacy reports carry their old summary fields on the report
// object itself (days keep the pre-chain shape and are not
// re-rendered by the dashboard).
export interface ChainReportDetail {
  report: SavedReport;
  model: "legacy" | "chain";
  days: MileageReportDay[];
  expenses: ExpenseLine[];
  total_billable_miles: number | null;
  total_personal_miles: number | null;
  total_driven_miles: number | null;
  mileage_amount_cents: number | null;
  expenses_amount_cents: number | null;
  total_amount_cents: number | null;
  events: ReportEvent[];
}

export interface MileageReport {
  user_id: number;
  clinician_name: string | null;
  from: string;
  to: string;
  agency_id: number | null;
  days: MileageReportDay[];
  total_billable_miles: number;
  total_personal_miles: number;
  total_driven_miles: number;
  // Mileage only — expenses and the grand total ride along
  // separately (deploy-41).
  total_amount_cents: number;
  expenses: ExpenseLine[];
  expenses_amount_cents: number;
  grand_total_amount_cents: number;
  policy: ExpensePolicy;
  receipt_violations: ReceiptViolation[];
}

export interface ApiRequestError extends Error {
  status?: number;
  code?: string;
  // The API's parsed error body, when it sent JSON — the
  // deploy-41 409/422s carry their payload here
  // (REPORT_EXISTS → existing_id, RECEIPTS_REQUIRED →
  // violations).
  body?: unknown;
}

async function apiFetch(
  user: User,
  path: string,
  init?: RequestInit,
  timeoutMs = 8000,
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
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let code: string | undefined;
    let message = `request failed (${res.status})`;
    let body: unknown;
    try {
      body = (await res.json()) as { code?: string; error?: string } | null;
      code = (body as { code?: string } | null)?.code;
      const errMsg = (body as { error?: string } | null)?.error;
      if (errMsg) message = errMsg;
    } catch {
      // status alone will have to do
    }
    const err = new Error(message) as ApiRequestError;
    err.status = res.status;
    err.code = code;
    err.body = body;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export async function fetchMileage(
  user: User,
  params: { from?: string; to?: string; agency_id?: number | null; user_id?: number } = {},
): Promise<MileageEntry[]> {
  const data = (await apiFetch(user, `/mileage${qs(params)}`)) as {
    entries: MileageEntry[];
  };
  return data.entries;
}

export async function createMileage(
  user: User,
  input: MileageInput,
): Promise<MileageEntry> {
  const data = (await apiFetch(user, "/mileage", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { entry: MileageEntry };
  return data.entry;
}

export async function updateMileage(
  user: User,
  id: number,
  input: MileageInput,
): Promise<MileageEntry> {
  const data = (await apiFetch(user, `/mileage/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  })) as { entry: MileageEntry };
  return data.entry;
}

export async function deleteMileage(user: User, id: number): Promise<void> {
  await apiFetch(user, `/mileage/${id}`, { method: "DELETE" });
}

export async function fetchMileageReport(
  user: User,
  params: { from: string; to: string; agency_id?: number | null; user_id?: number },
): Promise<MileageReport> {
  return (await apiFetch(user, `/mileage/report${qs(params)}`)) as MileageReport;
}

// Route one leg (coordinates only) → both figures; either may
// be null when only one variant routed; throws ROUTE_FAILED
// (502) when neither did.
// ---------- deploy-41 clients ----------

// Binary sibling of apiFetch (receipt content): same base +
// Firebase token discipline, but returns the raw blob and
// surfaces the same status/code error shape on failure.
async function apiFetchBlob(
  user: User,
  path: string,
  timeoutMs = 30000,
): Promise<Blob> {
  const base = apiBase();
  if (!base) throw new Error("patient API is not configured");
  const token = await user.getIdToken();
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let code: string | undefined;
    let message = `request failed (${res.status})`;
    let body: unknown;
    try {
      body = (await res.json()) as { code?: string; error?: string } | null;
      code = (body as { code?: string } | null)?.code;
      const errMsg = (body as { error?: string } | null)?.error;
      if (errMsg) message = errMsg;
    } catch {
      // status alone will have to do
    }
    const err = new Error(message) as ApiRequestError;
    err.status = res.status;
    err.code = code;
    err.body = body;
    throw err;
  }
  return res.blob();
}

function fileToBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin).replace(/^data:[^,]*,/, "");
  });
}

export async function uploadReceipt(
  user: User,
  kind: "mileage" | "expense",
  lineId: number,
  file: File,
): Promise<ReceiptMeta> {
  const data_base64 = await fileToBase64(file);
  const data = (await apiFetch(
    user,
    kind === "mileage" ? `/mileage/${lineId}/receipts` : `/expenses/${lineId}/receipts`,
    {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        mime_type: file.type,
        data_base64,
      }),
    },
    30000,
  )) as { receipt: ReceiptMeta };
  return data.receipt;
}

export async function listReceipts(
  user: User,
  kind: "mileage" | "expense",
  lineId: number,
): Promise<ReceiptMeta[]> {
  const data = (await apiFetch(
    user,
    kind === "mileage" ? `/mileage/${lineId}/receipts` : `/expenses/${lineId}/receipts`,
  )) as { receipts: ReceiptMeta[] };
  return data.receipts;
}

export async function deleteReceipt(user: User, id: number): Promise<void> {
  await apiFetch(user, `/expense-receipts/${id}`, { method: "DELETE" });
}

export async function fetchReceiptBlob(user: User, id: number): Promise<Blob> {
  return apiFetchBlob(user, `/expense-receipts/${id}/content`);
}

export async function fetchRates(user: User): Promise<MileageRate[]> {
  const data = (await apiFetch(user, "/mileage-rates")) as { rates: MileageRate[] };
  return data.rates;
}

export async function resolveRate(
  user: User,
  date: string,
): Promise<{ date: string; rate: number | null; rate_id: number | null }> {
  return (await apiFetch(user, `/mileage-rates/resolve${qs({ date })}`)) as {
    date: string;
    rate: number | null;
    rate_id: number | null;
  };
}

export async function createRate(
  user: User,
  input: { rate: number; effective_from: string },
): Promise<MileageRate> {
  const data = (await apiFetch(user, "/mileage-rates", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { rate: MileageRate };
  return data.rate;
}

export async function fetchPolicy(user: User): Promise<ExpensePolicy> {
  return (await apiFetch(user, "/expense-policy")) as ExpensePolicy;
}

export async function updatePolicy(
  user: User,
  input: ExpensePolicy,
): Promise<ExpensePolicy> {
  const data = (await apiFetch(user, "/expense-policy", {
    method: "PUT",
    body: JSON.stringify(input),
  })) as { policy?: ExpensePolicy } | ExpensePolicy;
  return (data as { policy?: ExpensePolicy }).policy ?? (data as ExpensePolicy);
}

export async function fetchExpenseLines(
  user: User,
  params: { from?: string; to?: string; agency_id?: number | null } = {},
): Promise<ExpenseLine[]> {
  const data = (await apiFetch(user, `/expenses${qs(params)}`)) as {
    expenses: ExpenseLine[];
  };
  return data.expenses;
}

export async function createExpenseLine(
  user: User,
  input: ExpenseLineInput,
): Promise<ExpenseLine> {
  const data = (await apiFetch(user, "/expenses", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { expense: ExpenseLine };
  return data.expense;
}

export async function updateExpenseLine(
  user: User,
  id: number,
  input: ExpenseLineInput,
): Promise<ExpenseLine> {
  const data = (await apiFetch(user, `/expenses/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  })) as { expense: ExpenseLine };
  return data.expense;
}

export async function deleteExpenseLine(user: User, id: number): Promise<void> {
  await apiFetch(user, `/expenses/${id}`, { method: "DELETE" });
}

export async function createReport(
  user: User,
  input: {
    period_start: string;
    period_end: string;
    agency_id?: number | null;
    title?: string;
    notes?: string;
  },
): Promise<SavedReport> {
  const data = (await apiFetch(user, "/expense-reports", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { report: SavedReport };
  return data.report;
}

export async function fetchReports(user: User): Promise<SavedReport[]> {
  const data = (await apiFetch(user, "/expense-reports")) as { reports: SavedReport[] };
  return data.reports;
}

export async function fetchReport(user: User, id: number): Promise<ChainReportDetail> {
  return (await apiFetch(user, `/expense-reports/${id}`)) as ChainReportDetail;
}

export async function transitionReport(
  user: User,
  id: number,
  input: {
    to: "submitted" | "approved" | "rejected" | "draft" | "paid";
    note?: string;
    payment_ref?: string;
  },
): Promise<{ report: SavedReport; event: ReportEvent }> {
  return (await apiFetch(user, `/expense-reports/${id}/transition`, {
    method: "POST",
    body: JSON.stringify(input),
  })) as { report: SavedReport; event: ReportEvent };
}

export async function routeMiles(
  user: User,
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<{ miles_toll: number | null; miles_no_toll: number | null }> {
  return (await apiFetch(user, "/mileage/route", {
    method: "POST",
    body: JSON.stringify({
      start_lat: from.lat,
      start_lng: from.lng,
      end_lat: to.lat,
      end_lng: to.lng,
    }),
  })) as { miles_toll: number | null; miles_no_toll: number | null };
}
