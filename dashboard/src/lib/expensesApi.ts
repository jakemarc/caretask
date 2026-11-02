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
    try {
      const body = (await res.json()) as { code?: string; error?: string } | null;
      code = body?.code;
      if (body?.error) message = body.error;
    } catch {
      // status alone will have to do
    }
    const err = new Error(message) as ApiRequestError;
    err.status = res.status;
    err.code = code;
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
