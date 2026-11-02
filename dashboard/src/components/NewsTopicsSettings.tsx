import { useState } from "react";
import {
  getNewsTopics,
  NEWS_TOPICS,
  setNewsTopics,
} from "../lib/newsTopics";

// Settings → News feed topics (2026-11-02): checkboxes choosing
// what appears in the Dashboard news card. Saved on this device;
// the card updates the moment a box changes.

export default function NewsTopicsSettings() {
  const [topics, setTopics] = useState<string[]>(() => getNewsTopics());

  function toggle(id: string, on: boolean) {
    const next = on
      ? [...topics, id]
      : topics.filter((t) => t !== id);
    setTopics(next);
    setNewsTopics(next);
  }

  return (
    <article className="card">
      <strong>News feed topics</strong>
      <p className="card-meta">
        Choose what appears in the Dashboard news card. Saved on
        this device.
      </p>
      <div className="news-topic-list">
        {NEWS_TOPICS.map((t) => (
          <label key={t.id} className="news-topic-row">
            <input
              type="checkbox"
              checked={topics.includes(t.id)}
              onChange={(e) => toggle(t.id, e.target.checked)}
            />
            <span>{t.label}</span>
          </label>
        ))}
      </div>
    </article>
  );
}
