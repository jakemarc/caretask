// Phone contacts sync (CardDAV) — per-clinician self-service
// (carddav-contacts-sync-spec.md §8). Mounted at /contact-sync
// behind requireAuth + requireStaff; every route acts on the
// CALLER's own sync only. The CardDAV password is returned
// exactly once (enable / regenerate) and never stored in our
// database — only its bcrypt hash in Radicale's htpasswd file.
const express = require('express');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');
const sync = require('../lib/contactSync');

const router = express.Router();

async function myRow(userId) {
  const { rows } = await pool.query('SELECT * FROM user_contact_sync WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

router.get('/me', async (req, res, next) => {
  try {
    const row = await myRow(req.staff.id);
    let contactCount = 0;
    if (row?.enabled) {
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM contact_sync_items WHERE user_id = $1',
        [req.staff.id],
      );
      contactCount = rows[0].n;
    }
    res.json({
      configured: sync.isConfigured(),
      enabled: Boolean(row?.enabled),
      dav_username: row?.dav_username || null,
      server_url: sync.config().publicUrl,
      book_name: sync.BOOK_NAME,
      last_sync_at: row?.last_sync_at || null,
      last_result: row?.last_result || null,
      contact_count: contactCount,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/me/enable', async (req, res, next) => {
  try {
    if (!sync.isConfigured()) {
      return res.status(503).json({ error: 'Phone contacts sync is not set up on the server yet.', code: 'SYNC_NOT_CONFIGURED' });
    }
    const existing = await myRow(req.staff.id);
    if (existing?.enabled) {
      return res.status(409).json({ error: 'Phone sync is already on. Use Regenerate password for a new password.', code: 'ALREADY_ENABLED' });
    }
    const { davUsername, password } = await sync.enableForUser(req.staff);
    const result = await sync.reconcileUser(req.staff.id, req.user);
    await insertEvent(pool, {
      actor: req.user,
      event: 'contact_sync',
      details: { action: 'enable', user_id: Number(req.staff.id) },
    });
    res.status(201).json({
      dav_username: davUsername,
      password,
      server_url: sync.config().publicUrl,
      book_name: sync.BOOK_NAME,
      sync: result,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/me/regenerate-password', async (req, res, next) => {
  try {
    if (!sync.isConfigured()) {
      return res.status(503).json({ error: 'Phone contacts sync is not set up on the server yet.', code: 'SYNC_NOT_CONFIGURED' });
    }
    const row = await myRow(req.staff.id);
    if (!row?.enabled) {
      return res.status(409).json({ error: 'Phone sync is not on yet.', code: 'NOT_ENABLED' });
    }
    const password = await sync.regeneratePassword(req.staff, row);
    await insertEvent(pool, {
      actor: req.user,
      event: 'contact_sync',
      details: { action: 'regenerate_password', user_id: Number(req.staff.id) },
    });
    res.json({ dav_username: row.dav_username, password });
  } catch (err) {
    next(err);
  }
});

router.post('/me/sync-now', async (req, res, next) => {
  try {
    if (!sync.isConfigured()) {
      return res.status(503).json({ error: 'Phone contacts sync is not set up on the server yet.', code: 'SYNC_NOT_CONFIGURED' });
    }
    const result = await sync.reconcileUser(req.staff.id, req.user);
    res.json({ sync: result });
  } catch (err) {
    next(err);
  }
});

router.delete('/me', async (req, res, next) => {
  try {
    const row = await myRow(req.staff.id);
    if (!row?.enabled) {
      return res.status(409).json({ error: 'Phone sync is not on.', code: 'NOT_ENABLED' });
    }
    await sync.disableForUser(req.staff, row);
    await insertEvent(pool, {
      actor: req.user,
      event: 'contact_sync',
      details: { action: 'disable', user_id: Number(req.staff.id) },
    });
    res.json({ disabled: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
