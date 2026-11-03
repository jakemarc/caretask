// Phone contacts sync engine (carddav-contacts-sync-spec.md).
//
// One-way mirror: CareTask -> a per-clinician CardDAV address
// book named "CareTask" on our own Radicale server. The API
// talks to Radicale on localhost as the service user (ctsync,
// read/write all books); each clinician's phone connects with
// its own read-only credential. Only directory fields sync
// (lib/vcard.js) — nothing clinical ever leaves through here.
//
// The feature is INERT unless CARDDAV_BASE_URL and
// CARDDAV_SYNC_PASSWORD are set in the API environment.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { insertEvent } = require('./eventLog');
const { buildVCard, contentHash } = require('./vcard');

const BOOK_NAME = 'CareTask';
const BOOK_SLUG = 'caretask';

function config() {
  return {
    baseUrl: (process.env.CARDDAV_BASE_URL || '').replace(/\/$/, ''),
    syncUser: process.env.CARDDAV_SYNC_USER || 'ctsync',
    syncPassword: process.env.CARDDAV_SYNC_PASSWORD || '',
    publicUrl: process.env.CARDDAV_PUBLIC_URL || 'https://contacts.marcinnotech.net',
    htpasswdPath: process.env.CARDDAV_HTPASSWD_PATH || '',
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.baseUrl && c.syncPassword && c.htpasswdPath);
}

// ---------------------------------------------------------------- DAV client
async function dav(method, p, { body = null, headers = {}, auth = null } = {}) {
  const c = config();
  const a = auth || { user: c.syncUser, pass: c.syncPassword };
  const h = {
    Authorization:
      'Basic ' + Buffer.from(`${a.user}:${a.pass}`).toString('base64'),
    ...headers,
  };
  if (body) h['Content-Type'] = h['Content-Type'] || 'application/xml; charset=utf-8';
  const res = await fetch(c.baseUrl + p, { method, headers: h, body });
  return res;
}

function parsePropfind(xml) {
  // Minimal multistatus reader: href + getetag per response.
  const out = [];
  const blocks = String(xml).split(/<(?:\w+:)?response[ >]/).slice(1);
  for (const b of blocks) {
    const href = b.match(/<(?:\w+:)?href>([^<]+)</)?.[1];
    if (!href) continue;
    const etag = b.match(/<(?:\w+:)?getetag>([^<]+)</)?.[1] || null;
    out.push({ href: decodeURIComponent(href), etag });
  }
  return out;
}

async function ensureBook(davUsername) {
  const bookPath = `/${davUsername}/${BOOK_SLUG}/`;
  const probe = await dav('PROPFIND', bookPath, {
    headers: { Depth: '0' },
    body: '<?xml version="1.0" encoding="utf-8" ?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
  });
  if (probe.status === 207) return bookPath;
  // Principal first (409 if the parent is missing), then the book.
  await dav('MKCOL', `/${davUsername}/`, {}).catch(() => {});
  const mk = await dav('MKCOL', bookPath, {
    body:
      '<?xml version="1.0" encoding="utf-8" ?>' +
      '<C:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
      '<D:set><D:prop><D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>' +
      `<D:displayname>${BOOK_NAME}</D:displayname></D:prop></D:set></C:mkcol>`,
  });
  if (![201, 207, 405].includes(mk.status)) {
    throw new Error(`create address book failed (HTTP ${mk.status})`);
  }
  return bookPath;
}

async function listBook(bookPath) {
  const res = await dav('PROPFIND', bookPath, {
    headers: { Depth: '1' },
    body: '<?xml version="1.0" encoding="utf-8" ?><propfind xmlns="DAV:"><prop><getetag/><resourcetype/></prop></propfind>',
  });
  if (res.status === 404) return new Map();
  if (res.status !== 207) throw new Error(`list book failed (HTTP ${res.status})`);
  const map = new Map();
  for (const r of parsePropfind(await res.text())) {
    if (r.href.endsWith('.vcf')) map.set(r.href, r.etag);
  }
  return map;
}

async function putCard(href, cardBody, etag) {
  const headers = { 'Content-Type': 'text/vcard; charset=utf-8' };
  if (etag) headers['If-Match'] = etag;
  let res = await dav('PUT', href, { body: cardBody, headers });
  if (res.status === 412 && etag) {
    // Someone touched the server copy; CareTask is the record — overwrite.
    delete headers['If-Match'];
    res = await dav('PUT', href, { body: cardBody, headers });
  }
  if (![200, 201, 204].includes(res.status)) {
    throw new Error(`put contact failed (HTTP ${res.status})`);
  }
  return res.headers.get('etag');
}

async function deleteHref(href) {
  const res = await dav('DELETE', href, {});
  if (![200, 204, 404].includes(res.status)) {
    throw new Error(`delete contact failed (HTTP ${res.status})`);
  }
}

// ---------------------------------------------------------------- htpasswd
function readHtpasswd() {
  const c = config();
  const entries = new Map();
  try {
    for (const line of fs.readFileSync(c.htpasswdPath, 'utf8').split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) entries.set(line.slice(0, i), line.slice(i + 1));
    }
  } catch {
    /* file may not exist yet */
  }
  return entries;
}

function writeHtpasswd(entries) {
  const c = config();
  const dir = path.dirname(c.htpasswdPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = c.htpasswdPath + '.tmp';
  const body = [...entries.entries()].map(([u, h]) => `${u}:${h}`).join('\n') + '\n';
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, c.htpasswdPath);
  maybeReloadRadicale();
}

function maybeReloadRadicale() {
  // Radicale may cache the htpasswd file; on the VM the API user
  // has a narrow sudoers rule for reloading just this service.
  if (process.env.CARDDAV_HTPASSWD_RELOAD !== 'systemctl') return;
  execFile('sudo', ['-n', 'systemctl', 'reload-or-restart', 'radicale'], () => {});
}

function setDavPassword(davUsername, plain) {
  const entries = readHtpasswd();
  entries.set(davUsername, bcrypt.hashSync(plain, 10));
  writeHtpasswd(entries);
}

function removeDavUser(davUsername) {
  const entries = readHtpasswd();
  if (entries.delete(davUsername)) writeHtpasswd(entries);
}

function newPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

// ---------------------------------------------------------------- reconcile
async function desiredContacts(userId) {
  const { rows } = await pool.query(
    `SELECT p.* FROM patient_links l
       JOIN patients p ON p.id = l.patient_id
      WHERE l.user_id = $1 AND l.removed_at IS NULL
        AND l.list_status = 'active' AND p.deleted_at IS NULL`,
    [userId],
  );
  return rows;
}

async function reconcileUser(userId, actor = { uid: null, email: null }) {
  if (!isConfigured()) return { skipped: 'not_configured' };
  const { rows: syncRows } = await pool.query(
    'SELECT * FROM user_contact_sync WHERE user_id = $1',
    [userId],
  );
  const sync = syncRows[0];
  if (!sync || !sync.enabled) return { skipped: 'not_enabled' };
  try {
    const bookPath = sync.book_path || (await ensureBook(sync.dav_username));
    if (!sync.book_path) {
      await pool.query('UPDATE user_contact_sync SET book_path = $2 WHERE user_id = $1', [userId, bookPath]);
    }
    const { rows: staffRows } = await pool.query('SELECT active FROM users WHERE id = $1', [userId]);
    const staffActive = staffRows[0]?.active === true;
    const desired = staffActive ? await desiredContacts(userId) : [];
    const { rows: itemRows } = await pool.query(
      'SELECT * FROM contact_sync_items WHERE user_id = $1',
      [userId],
    );
    const items = new Map(itemRows.map((r) => [r.patient_id, r]));
    const onServer = await listBook(bookPath);
    const rev = new Date().toISOString();
    let created = 0, updated = 0, deleted = 0;
    const desiredIds = new Set();
    for (const p of desired) {
      desiredIds.add(p.id);
      const hash = contentHash(p);
      const href = `${bookPath}${p.id}.vcf`;
      const item = items.get(p.id);
      if (item && item.content_hash === hash && onServer.has(item.dav_href)) continue;
      const etag = await putCard(href, buildVCard(p, rev), item?.dav_etag || onServer.get(href) || null);
      await pool.query(
        `INSERT INTO contact_sync_items (user_id, patient_id, dav_href, dav_etag, content_hash, synced_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (user_id, patient_id) DO UPDATE
           SET dav_href = EXCLUDED.dav_href, dav_etag = EXCLUDED.dav_etag,
               content_hash = EXCLUDED.content_hash, synced_at = now()`,
        [userId, p.id, href, etag, hash],
      );
      if (item) updated += 1; else created += 1;
    }
    for (const [patientId, item] of items) {
      if (desiredIds.has(patientId)) continue;
      await deleteHref(item.dav_href);
      await pool.query('DELETE FROM contact_sync_items WHERE user_id = $1 AND patient_id = $2', [userId, patientId]);
      deleted += 1;
    }
    await pool.query(
      "UPDATE user_contact_sync SET last_sync_at = now(), last_result = 'ok', updated_at = now() WHERE user_id = $1",
      [userId],
    );
    if (created || updated || deleted) {
      await insertEvent(pool, {
        actor,
        event: 'contact_sync',
        details: { action: 'reconcile', user_id: Number(userId), created, updated, deleted },
      });
    }
    return { created, updated, deleted, total: desired.length };
  } catch (err) {
    const msg = String(err.message || err).slice(0, 200);
    await pool
      .query("UPDATE user_contact_sync SET last_result = $2, updated_at = now() WHERE user_id = $1", [userId, `error: ${msg}`])
      .catch(() => {});
    await insertEvent(pool, {
      actor,
      event: 'contact_sync',
      details: { action: 'error', user_id: Number(userId), error: msg },
    }).catch(() => {});
    return { error: msg };
  }
}

// ---------------------------------------------------------------- triggers
const timers = new Map();
function pokeUser(userId) {
  if (!isConfigured() || userId == null) return;
  const key = String(userId);
  if (timers.has(key)) clearTimeout(timers.get(key));
  const t = setTimeout(() => {
    timers.delete(key);
    reconcileUser(userId).catch(() => {});
  }, 1500);
  t.unref?.();
  timers.set(key, t);
}

async function pokePatient(patientId) {
  if (!isConfigured()) return;
  try {
    const { rows } = await pool.query(
      'SELECT user_id FROM patient_links WHERE patient_id = $1 AND removed_at IS NULL',
      [patientId],
    );
    for (const r of rows) pokeUser(r.user_id);
  } catch {
    /* triggers never break the request path */
  }
}

// ---------------------------------------------------------------- lifecycle
async function enableForUser(staff) {
  const davUsername = `u${staff.id}`;
  const password = newPassword();
  setDavPassword(davUsername, password);
  const bookPath = await ensureBook(davUsername);
  await pool.query(
    `INSERT INTO user_contact_sync (user_id, dav_username, enabled, book_path)
     VALUES ($1, $2, true, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET dav_username = EXCLUDED.dav_username, enabled = true,
           book_path = EXCLUDED.book_path, updated_at = now()`,
    [staff.id, davUsername, bookPath],
  );
  return { davUsername, password, bookPath };
}

async function regeneratePassword(staff, syncRow) {
  const password = newPassword();
  setDavPassword(syncRow.dav_username, password);
  return password;
}

async function disableForUser(staff, syncRow) {
  // Remove the server-side book and credential entirely: the
  // contacts leave the phone with the account, immediately here.
  await dav('DELETE', `/${syncRow.dav_username}/`, {}).catch(() => {});
  removeDavUser(syncRow.dav_username);
  await pool.query('DELETE FROM contact_sync_items WHERE user_id = $1', [staff.id]);
  await pool.query(
    'UPDATE user_contact_sync SET enabled = false, book_path = NULL, updated_at = now() WHERE user_id = $1',
    [staff.id],
  );
}

let hourlyTimer = null;
function startContactSyncTimer() {
  if (hourlyTimer || !isConfigured()) return;
  hourlyTimer = setInterval(async () => {
    try {
      const { rows } = await pool.query('SELECT user_id FROM user_contact_sync WHERE enabled = true');
      for (const r of rows) await reconcileUser(r.user_id);
    } catch {
      /* next hour retries */
    }
  }, 60 * 60 * 1000);
  hourlyTimer.unref?.();
}

module.exports = {
  BOOK_NAME,
  config,
  isConfigured,
  ensureBook,
  listBook,
  putCard,
  deleteHref,
  setDavPassword,
  removeDavUser,
  reconcileUser,
  pokeUser,
  pokePatient,
  enableForUser,
  regeneratePassword,
  disableForUser,
  startContactSyncTimer,
};
