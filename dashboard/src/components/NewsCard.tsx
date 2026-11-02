import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { fetchNews, type NewsItem } from "../lib/newsApi";
import {
  getNewsTopics,
  NEWS_TOPICS,
  NEWS_TOPICS_EVENT,
} from "../lib/newsTopics";

// Dashboard news card (2026-11-02) — one card of headlines about
// physical therapy, home health, and APTA (plus any topics the
// clinician turns on in Settings → News feed topics). The API
// fetches the publishers' feeds server-side and trims each item
// to a short title + short description; this card shows the
// first four and counts the rest behind "+ N more headlines",
// which expands inside the card (the overview never grows the
// page). Connected mode only, like the calendar and reminders.

function agoLabel(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(1, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${days}d ago`;
}

export default function NewsCard({
  user,
  apiConnected,
}: {
  user: User;
  apiConnected: boolean;
}) {
  const [topics, setTopics] = useState<string[]>(() => getNewsTopics());
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<string[]>).detail;
      setTopics(Array.isArray(detail) ? detail : getNewsTopics());
    };
    window.addEventListener(NEWS_TOPICS_EVENT, onChange);
    return () => window.removeEventListener(NEWS_TOPICS_EVENT, onChange);
  }, []);

  useEffect(() => {
    if (!apiConnected) return;
    let live = true;
    setItems(null);
    setExpanded(false);
    fetchNews(user, topics, 12)
      .then((list) => {
        if (live) setItems(list);
      })
      .catch(() => {
        if (live) setItems([]);
      });
    return () => {
      live = false;
    };
  }, [apiConnected, topics, user]);

  const topicLabels = NEWS_TOPICS.filter((t) => topics.includes(t.id))
    .map((t) => t.label)
    .join(" · ");
  const visible = expanded ? (items ?? []) : (items ?? []).slice(0, 4);
  const moreCount = (items?.length ?? 0) - visible.length;

  return (
    <div className="overview-panel news-card">
      <h2>PT &amp; Home Health News</h2>
      {!apiConnected && (
        <p className="section-note">
          News needs the patient API connection.
        </p>
      )}
      {apiConnected && items === null && (
        <p className="section-note">Loading headlines…</p>
      )}
      {apiConnected && items !== null && items.length === 0 && (
        <p className="section-note">
          No headlines right now
          {topics.length === 0
            ? " — every topic is off. Turn topics on in Settings → News feed topics."
            : " — the feeds may be quiet or unreachable. They refresh on their own."}
        </p>
      )}
      {apiConnected && items !== null && items.length > 0 && (
        <>
          {topicLabels && <p className="news-topics-line">{topicLabels}</p>}
          <div className={`news-list${expanded ? " expanded" : ""}`}>
            {visible.map((item) => (
              <a
                key={item.link}
                className="news-item"
                href={item.link}
                target="_blank"
                rel="noreferrer"
              >
                <span className="news-title">{item.title}</span>
                {item.description && (
                  <span className="news-desc">{item.description}</span>
                )}
                <span className="news-meta">
                  {item.source}
                  {item.published_at
                    ? ` · ${agoLabel(item.published_at)}`
                    : ""}
                </span>
              </a>
            ))}
          </div>
          {moreCount > 0 && (
            <button
              type="button"
              className="news-more"
              onClick={() => setExpanded(true)}
            >
              + {moreCount} more headlines
            </button>
          )}
          {expanded && items.length > 4 && (
            <button
              type="button"
              className="news-more"
              onClick={() => setExpanded(false)}
            >
              Show fewer
            </button>
          )}
        </>
      )}
    </div>
  );
}
