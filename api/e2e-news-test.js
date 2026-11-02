// End-to-end tests for the dashboard news API — LOCAL TEST ONLY.
// No database: the route serves publisher RSS/Atom trimmed to
// short titles/descriptions. The feed list is replaced through
// NEWS_FEEDS_JSON with two fixture feeds served by this process
// (one RSS, one Atom) plus one dead URL, proving: topic filtering
// → merge + newest-first sort + link dedupe → short text trimming
// → a dead feed never failing the response → strict validation.
//
// Run: E2E_PORT=3116 node e2e-news-test.js
const http = require('http');

const PORT = Number(process.env.E2E_PORT || 3116);
const FIXTURE_PORT = PORT + 100;
const BASE = `http://127.0.0.1:${PORT}`;

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Fixture Home Health</title>
<item>
  <title><![CDATA[A Very Long Fixture Headline About Home Health Staffing That Goes On And On And On And On And On And On And On And On]]></title>
  <link>https://example.org/hh-1</link>
  <pubDate>Mon, 02 Nov 2026 12:00:00 GMT</pubDate>
  <description><![CDATA[<p>First fixture description with <b>markup</b> that must be stripped down to plain readable text for the dashboard card, kept short and clean.</p>]]></description>
</item>
<item>
  <title>Older Home Health Item</title>
  <link>https://example.org/hh-2</link>
  <pubDate>Sun, 01 Nov 2026 12:00:00 GMT</pubDate>
  <description>Second fixture description.</description>
</item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Fixture Journal</title>
<entry>
  <title>Newer Research Entry Wins The Sort</title>
  <link rel="alternate" href="https://example.org/res-1"/>
  <published>2026-11-02T15:30:00Z</published>
  <summary>Research summary &amp; findings in brief.</summary>
</entry>
<entry>
  <title>Duplicate Link Entry</title>
  <link rel="alternate" href="https://example.org/hh-1"/>
  <published>2026-11-02T16:00:00Z</published>
  <summary>Same link as the RSS item — must be deduped away.</summary>
</entry>
</feed>`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function main() {
  const fixtures = http.createServer((req, res) => {
    if (req.url === '/hh.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(RSS);
    } else if (req.url === '/res.xml') {
      res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
      res.end(ATOM);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => fixtures.listen(FIXTURE_PORT, '127.0.0.1', r));

  process.env.NEWS_FEEDS_JSON = JSON.stringify([
    {
      source: 'Fixture HH',
      url: `http://127.0.0.1:${FIXTURE_PORT}/hh.xml`,
      topics: ['home_health'],
    },
    {
      source: 'Fixture Journal',
      url: `http://127.0.0.1:${FIXTURE_PORT}/res.xml`,
      topics: ['research'],
    },
    {
      source: 'Fixture Dead',
      url: `http://127.0.0.1:${FIXTURE_PORT}/missing.xml`,
      topics: ['apta'],
    },
  ]);

  const express = require('express');
  const newsRouter = require('./routes/news');
  const app = express();
  app.use((req, res, next) => {
    req.user = { uid: 'news-tester', email: 'news@example.com' };
    next();
  });
  app.use('/news', newsRouter);
  const server = await new Promise((r) => {
    const srv = app.listen(PORT, '127.0.0.1', () => r(srv));
  });

  try {
    const all = await (await fetch(`${BASE}/news`)).json();
    check('all topics: 3 items after dedupe', all.items.length === 3, `got ${all.items.length}`);
    check(
      'newest first (Atom research item leads)',
      all.items[0] && all.items[0].link === 'https://example.org/res-1',
    );
    check(
      'dead feed tolerated, response still 200-shaped',
      Array.isArray(all.items) && typeof all.fetched_at === 'string',
    );
    const longItem = all.items.find((i) => i.link === 'https://example.org/hh-1');
    check(
      'RSS title trimmed short',
      !!longItem && longItem.title.length <= 111 && longItem.title.endsWith('…'),
      longItem && longItem.title,
    );
    check(
      'description is plain text (markup stripped)',
      !!longItem && !/<[a-z]/i.test(longItem.description),
    );
    check(
      'entities decoded in Atom summary',
      all.items[0] && all.items[0].description.includes('& findings'),
    );
    check('topics catalog returned', Array.isArray(all.topics) && all.topics.length === 5);

    const hh = await (await fetch(`${BASE}/news?topics=home_health`)).json();
    check(
      'topic filter: home_health only',
      hh.items.length === 2 && hh.items.every((i) => i.topics.includes('home_health')),
      `got ${hh.items.length}`,
    );

    const limited = await (await fetch(`${BASE}/news?limit=1`)).json();
    check('limit clamps the list', limited.items.length === 1);

    const bad = await fetch(`${BASE}/news?topics=bogus`);
    const badJson = await bad.json();
    check('unknown topic is a 400 TOPIC_UNKNOWN', bad.status === 400 && badJson.code === 'TOPIC_UNKNOWN');
  } finally {
    server.close();
    fixtures.close();
  }

  console.log(failures === 0 ? 'NEWS SUITE: ALL PASS' : `NEWS SUITE: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
