// News feed topics (2026-11-02) — the Settings → News feed
// topics switches. The choice lives on this device (localStorage,
// like the theme and the calling app); the Dashboard news card
// reads it, Settings writes it, and a same-tab event keeps the
// two in sync without a reload.

export interface NewsTopic {
  id: string;
  label: string;
}

export const NEWS_TOPICS: NewsTopic[] = [
  { id: "physical_therapy", label: "Physical therapy" },
  { id: "home_health", label: "Home health" },
  { id: "apta", label: "APTA" },
  { id: "medicare_cms", label: "Medicare & CMS policy" },
  { id: "research", label: "Rehab research" },
];

const KEY = "caretask-news-topics";
export const NEWS_TOPICS_EVENT = "caretask-news-topics-changed";

const DEFAULT_TOPICS = ["physical_therapy", "home_health", "apta"];

export function getNewsTopics(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [...DEFAULT_TOPICS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_TOPICS];
    const valid = parsed.filter(
      (t): t is string =>
        typeof t === "string" && NEWS_TOPICS.some((x) => x.id === t),
    );
    return valid;
  } catch {
    return [...DEFAULT_TOPICS];
  }
}

export function setNewsTopics(topics: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(topics));
  } catch {
    // Private browsing etc. — the in-memory event still applies
    // for this session.
  }
  window.dispatchEvent(
    new CustomEvent<string[]>(NEWS_TOPICS_EVENT, { detail: topics }),
  );
}
