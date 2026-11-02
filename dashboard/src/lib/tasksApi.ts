// Clinician tasks API client (2026-11-02) — the todo/reminder
// list. Mirrors patientApi.ts's fetch discipline (Firebase ID
// token, API error code surfaced on the thrown error). Tasks are
// owner-scoped at the API: these calls only ever see the signed-in
// clinician's own tasks.
import type { User } from "firebase/auth";
import { apiBase } from "./patientApi";

export interface ClinicianTask {
  id: number;
  patient_id: string | null;
  patient_name: string | null;
  title: string;
  notes: string | null;
  due_at: string | null;
  done: boolean;
  done_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiRequestError extends Error {
  status?: number;
  code?: string;
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
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
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
  if (res.status === 204) return null;
  return res.json();
}

export async function fetchTasks(
  user: User,
  patientId?: string,
): Promise<ClinicianTask[]> {
  const q = new URLSearchParams({ scope: "all" });
  if (patientId) q.set("patient_id", patientId);
  const data = (await apiFetch(user, `/tasks?${q.toString()}`)) as {
    tasks: ClinicianTask[];
  };
  return data.tasks;
}

export async function createTask(
  user: User,
  input: {
    title: string;
    patient_id?: string | null;
    due_at?: string | null;
    notes?: string | null;
  },
): Promise<ClinicianTask> {
  const data = (await apiFetch(user, "/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { task: ClinicianTask };
  return data.task;
}

export async function updateTask(
  user: User,
  id: number,
  patch: {
    title?: string;
    notes?: string | null;
    due_at?: string | null;
    patient_id?: string | null;
    done?: boolean;
  },
): Promise<ClinicianTask> {
  const data = (await apiFetch(user, `/tasks/${id}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  })) as { task: ClinicianTask };
  return data.task;
}

export async function deleteTask(user: User, id: number): Promise<void> {
  await apiFetch(user, `/tasks/${id}`, { method: "DELETE" });
}
