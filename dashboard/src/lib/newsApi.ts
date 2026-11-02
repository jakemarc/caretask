// Dashboard news API client (2026-11-02) — headlines fetched
// server-side by the API (publishers block direct browser reads)
// and trimmed there to a short title + short description. Mirrors
// tasksApi.ts's fetch discipline (Firebase ID token, 5s timeout).
import type { User } from "firebase/auth";
import { apiBase } from "./patientApi";

export interface NewsItem {
  title: string;
  description: string;
  link: string;
  source: string;
  topics: string[];
  published_at: string | null;
}

export async function fetchNews(
  user: User,
  topics: string[],
  limit = 12,
): Promise<NewsItem[]> {
  const base = apiBase();
  if (!base) throw new Error("patient API is not configured");
  const token = await user.getIdToken();
  const q = new URLSearchParams({ limit: String(limit) });
  if (topics.length > 0) q.set("topics", topics.join(","));
  const res = await fetch(`${base}/news?${q.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`news request failed: ${res.status}`);
  const data = (await res.json()) as { items: NewsItem[] };
  return data.items;
}
