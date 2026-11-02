// Dashboard news (2026-11-02) — GET /news?topics=a,b&limit=n.
// Mounted behind requireAuth in server.js: signed-in staff only.
// Query validation is strict: an unknown topic is a 400, and the
// limit is clamped to 1..30. Feed failures never fail the request
// (see lib/newsFeeds.js) — a bad morning at a publisher just means
// fewer headlines.
const express = require('express');
const { TOPICS, getNews } = require('../lib/newsFeeds');

const router = express.Router();
const TOPIC_IDS = new Set(TOPICS.map((t) => t.id));

router.get('/', async (req, res) => {
  let topics = null;
  if (typeof req.query.topics === 'string' && req.query.topics.trim()) {
    topics = req.query.topics
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const unknown = topics.filter((t) => !TOPIC_IDS.has(t));
    if (unknown.length > 0) {
      return res.status(400).json({
        error: `Unknown news topic: ${unknown[0]}`,
        code: 'TOPIC_UNKNOWN',
      });
    }
  }
  let limit = Number(req.query.limit ?? 12);
  if (!Number.isFinite(limit)) limit = 12;
  limit = Math.min(30, Math.max(1, Math.trunc(limit)));
  try {
    const items = await getNews(topics, limit);
    return res.json({ items, topics: TOPICS, fetched_at: new Date().toISOString() });
  } catch {
    return res
      .status(502)
      .json({ error: 'News feeds are unavailable right now.', code: 'NEWS_FAILED' });
  }
});

module.exports = router;
