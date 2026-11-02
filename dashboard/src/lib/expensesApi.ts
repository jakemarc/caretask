// Expense Reports API client (2026-11-01).
//
// Mirrors patientApi.ts's fetch discipline (Firebase ID token,
// status + API error code surfaced on the thrown error) against
// the expense-reports routes. Types follow the API's
// normalization: ids and NUMERICs arrive as numbers, DATEs as
// 'YYYY-MM-DD' strings.
import type { User } from "firebase/auth";
import { apiBase } from "./patientApi";

export interface ExpenseReport {
  id: number;
  user_id: number;
  agency_id: number | null;
  title: string | null;
  period_start: string;
  period_end: string;
  status: "draft" | "submitted" | "approved" | "rejected" | "paid";
  submitted_at: string | null;
  approved_by: number | null;
  approved_at: string | null;
  paid_at: string | null;
  payment_ref: string | null;
  notes: string | null;
  owner_name?: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MileageEntry {
  id: number;
  expense_report_id: number;
  entry_date: string;
  seq: number;
  entry_kind: "business" | "commute";
  start_address: string | null;
  end_address: string | null;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  appointment_id: number | null;
  miles_toll: number | null;
  miles_no_toll: number | null;
  used_tollway: boolean;
  round_trip: boolean;
  business_miles: number;
  rate_per_mile: number | null;
  vehicle: string | null;
  notes: string | null;
  deleted_at: string | null;
}

export interface ExpenseLine {
  id: number;
  report_id: number;
  user_id: number;
  expense_date: string;
  category: string;
  description: string | null;
  vendor_name: string | null;
  amount_cents: number;
  payment_method: string | null;
  receipt_url: string | null;
  agency_id: number | null;
  notes: string | null;
  deleted_at: string | null;
}

export interface ReportDay {
  date: string;
  driven_miles: number;
  commute_miles: number;
  reimbursable_miles: number;
  entries: MileageEntry[];
}

export interface ReportDetail {
  report: ExpenseReport;
  days: ReportDay[];
  expenses: ExpenseLine[];
  total_driven_miles: number;
  total_commute_miles: number;
  total_reimbursable_miles: number;
  mileage_amount_cents: number;
  expenses_amount_cents: number;
  total_amount_cents: number;
}

export interface ApiRequestError extends Error {
  status?: number;
  code?: string;
}

async function apiFetch(
  user: User,
  path: string,
  init?: RequestInit,
  timeoutMs = 5000,
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
    try {
      const body = (await res.json()) as { code?: string } | null;
      code = body?.code;
    } catch {
      // status alone will have to do
    }
    const err = new Error(
      `expense API request failed: ${res.status}`,
    ) as ApiRequestError;
    err.status = res.status;
    err.code = code;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

// The label a report shows: its friendly title when set, else
// one generated from the period ("October 2026 Expense
// Report").
export function reportLabel(r: ExpenseReport): string {
  if (r.title) return r.title;
  const start = new Date(`${r.period_start}T12:00:00`);
  const month = start.toLocaleString("en-US", { month: "long" });
  return `${month} ${start.getFullYear()} Expense Report`;
}

export async function listExpenseReports(user: User): Promise<ExpenseReport[]> {
  return (await apiFetch(user, "/expense-reports")) as ExpenseReport[];
}

export async function createExpenseReport(
  user: User,
  body: { period_start: string; period_end: string; title?: string },
): Promise<ExpenseReport> {
  const out = (await apiFetch(user, "/expense-reports", json(body))) as {
    report: ExpenseReport;
  };
  return out.report;
}

export async function getExpenseReport(
  user: User,
  id: number,
): Promise<ReportDetail> {
  return (await apiFetch(user, `/expense-reports/${id}`)) as ReportDetail;
}

export async function deleteExpenseReport(user: User, id: number): Promise<void> {
  await apiFetch(user, `/expense-reports/${id}`, { method: "DELETE" });
}

export async function submitExpenseReport(
  user: User,
  id: number,
): Promise<ExpenseReport> {
  const out = (await apiFetch(user, `/expense-reports/${id}/submit`, {
    method: "POST",
  })) as { report: ExpenseReport };
  return out.report;
}

// Lifecycle actions (approve / reject / pay) are ROLE-GATED on
// the API (manager/admin), and a manager cannot process their
// own report (403 SELF_APPROVAL).
export async function approveExpenseReport(
  user: User,
  id: number,
): Promise<ExpenseReport> {
  const out = (await apiFetch(user, `/expense-reports/${id}/approve`, { method: "POST" })) as {
    report: ExpenseReport;
  };
  return out.report;
}

export async function rejectExpenseReport(
  user: User,
  id: number,
): Promise<ExpenseReport> {
  const out = (await apiFetch(user, `/expense-reports/${id}/reject`, { method: "POST" })) as {
    report: ExpenseReport;
  };
  return out.report;
}

export async function payExpenseReport(
  user: User,
  id: number,
  paymentRef: string,
): Promise<ExpenseReport> {
  const out = (await apiFetch(user, `/expense-reports/${id}/pay`, {
    method: "POST",
    body: JSON.stringify({ payment_ref: paymentRef || undefined }),
  })) as { report: ExpenseReport };
  return out.report;
}

export type MileageEntryInput = Omit<
  MileageEntry,
  "id" | "expense_report_id" | "deleted_at"
>;

export async function addMileageEntry(
  user: User,
  reportId: number,
  body: Partial<MileageEntryInput> & { entry_date: string; business_miles: number },
): Promise<MileageEntry> {
  const out = (await apiFetch(
    user,
    `/expense-reports/${reportId}/mileage`,
    json(body),
  )) as { entry: MileageEntry };
  return out.entry;
}

export async function deleteMileageEntry(
  user: User,
  reportId: number,
  entryId: number,
): Promise<void> {
  await apiFetch(user, `/expense-reports/${reportId}/mileage/${entryId}`, {
    method: "DELETE",
  });
}

export type ExpenseLineInput = Pick<
  ExpenseLine,
  "expense_date" | "category" | "amount_cents"
> &
  Partial<Omit<ExpenseLine, "id" | "report_id" | "user_id" | "deleted_at" | "expense_date" | "category" | "amount_cents">>;

export async function addExpenseLine(
  user: User,
  reportId: number,
  body: ExpenseLineInput,
): Promise<ExpenseLine> {
  const out = (await apiFetch(
    user,
    `/expense-reports/${reportId}/expenses`,
    json(body),
  )) as { expense: ExpenseLine };
  return out.expense;
}

export async function deleteExpenseLine(
  user: User,
  reportId: number,
  expenseId: number,
): Promise<void> {
  await apiFetch(user, `/expense-reports/${reportId}/expenses/${expenseId}`, {
    method: "DELETE",
  });
}

// Road miles for one leg, both routing variants. Longer
// timeout than the standard calls — a public routing engine
// can take a few seconds. Either figure may be null.
export async function routeMileage(
  user: User,
  coords: { start_lat: number; start_lng: number; end_lat: number; end_lng: number },
): Promise<{ miles_toll: number | null; miles_no_toll: number | null }> {
  return (await apiFetch(user, "/mileage/route", json(coords), 20000)) as {
    miles_toll: number | null;
    miles_no_toll: number | null;
  };
}
