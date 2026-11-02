// Dashboard news feeds (2026-11-02) — the API fetches publisher
// RSS/Atom feeds server-side (browsers cannot: most publishers
// block cross-site reads), trims each item to a SHORT title and a
// SHORT description, and hands the dashboard clean JSON. Nothing
// is stored; a 10-minute in-memory cache keeps publisher traffic
// at ordinary-reader levels. A feed that fails or times out drops
// out of that response only — the others still answer.
//
// Topics are the Settings → News feed topics switches. One feed
// can carry several topics (the APTA feed is both the APTA topic
// and the physical-therapy topic). The feed list can be replaced
// wholesale with NEWS_FEEDS_JSON (a JSON array of
// {source, url, topics}) without a code change.

const DEFAULT_FEEDS = [
  {
    source: 'APTA',
    url: 'https://www.apta.org/Resource/rss-feed',
    topics: ['apta', 'physical_therapy'],
  },
  {
    source: 'Home Health Care News',
    url: 'https://homehealthcarenews.com/category/home-health-care/feed/',
    topics: ['home_health'],
  },
  {
    source: 'Home Health Care News',
    url: 'https://homehealthcarenews.com/category/cms/feed/',
    topics: ['medicare_cms'],
  },
  {
    source: 'PTJ — Physical Therapy & Rehabilitation Journal',
    url: 'https://academic.oup.com/rss/site_6037/3431_56068.xml',
    topics: ['research'],
  },
];

const TOPICS = [
  { id: 'physical_therapy', label: 'Physical therapy' },
  { id: 'home_health', label: 'Home health' },
  { id: 'apta', label: 'APTA' },
  { id: 'medicare_cms', label: 'Medicare & CMS policy' },
  { id: 'research', label: 'Rehab research' },
];

function loadFeeds() {
  const raw = process.env.NEWS_FEEDS_JSON;
  if (!raw) return DEFAULT_FEEDS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.filter(
        (f) => f && typeof f.url === 'string' && Array.isArray(f.topics),
      );
    }
  } catch {
    // A bad override falls back to the built-in list.
  }
  return DEFAULT_FEEDS;
}

const FEEDS = loadFeeds();
const CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const cache = new Map(); // url -> { at, items }

function decodeEntities(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function cleanText(raw, max) {
  const text = decodeEntities(String(raw || ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trim()}…`;
}

function tagValue(block, tag) {
  const m = block.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'),
  );
  return m ? m[1] : '';
}

function parseFeed(xml, feed) {
  const items = [];
  const blocks =
    xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ||
    xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ||
    [];
  for (const block of blocks) {
    const title = cleanText(tagValue(block, 'title'), 110);
    let link = cleanText(tagValue(block, 'link'), 500);
    if (!link) {
      // Atom: <link href="..."/> — prefer rel="alternate".
      const alt = block.match(
        /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i,
      );
      const any = block.match(/<link[^>]*href="([^"]+)"/i);
      link = (alt || any || [])[1] || '';
    }
    if (!title || !link) continue;
    const description = cleanText(
      tagValue(block, 'description') ||
        tagValue(block, 'summary') ||
        tagValue(block, 'content'),
      180,
    );
    const dateRaw =
      tagValue(block, 'pubDate') ||
      tagValue(block, 'dc:date') ||
      tagValue(block, 'published') ||
      tagValue(block, 'updated');
    const when = Date.parse(decodeEntities(dateRaw).trim());
    items.push({
      title,
      description,
      link,
      source: feed.source,
      topics: feed.topics,
      published_at: Number.isNaN(when) ? null : new Date(when).toISOString(),
    });
    if (items.length >= 10) break;
  }
  return items;
}

async function fetchFeed(feed) {
  const hit = cache.get(feed.url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;
  const res = await fetch(feed.url, {
    headers: {
      'User-Agent': 'CareTaskDashboard/1.0 (+https://marcinnotech.net)',
      Accept: 'application/rss+xml, application/atom+xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`feed answered ${res.status}`);
  const xml = await res.text();
  const items = parseFeed(xml, feed);
  cache.set(feed.url, { at: Date.now(), items });
  return items;
}

// topics: array of topic ids, or null for every topic.
async function getNews(topics, limit) {
  const wanted = topics
    ? FEEDS.filter((f) => f.topics.some((t) => topics.includes(t)))
    : FEEDS;
  const settled = await Promise.all(
    wanted.map((f) => fetchFeed(f).catch(() => [])),
  );
  const seen = new Set();
  const items = [];
  for (const list of settled) {
    for (const item of list) {
      if (seen.has(item.link)) continue;
      seen.add(item.link);
      items.push(item);
    }
  }
  items.sort((a, b) =>
    String(b.published_at || '').localeCompare(String(a.published_at || '')),
  );
  return items.slice(0, limit);
}

module.exports = { FEEDS, TOPICS, getNews, parseFeed, cleanText };
