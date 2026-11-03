// E2E suite for the multi-user platform (spec:
// multi-user-platform-spec.md). Exercises, with several stub
// users: the staff-record gate, registry duplicate rules
// (hard block / near-match prompt / confirm-create / Known
// Non-Duplicate suppression), per-user list scoping + links,
// episodes (create conflict, team rules, discharge, recertify,
// transfer), the booking gate (team, coverage, series), calendar
// scopes (personal / master / all), invites + provisioning, the
// clinicians directory scoping, and my-agencies.
//
// Like the other suites: SINGLE-RUN against a FRESH database
// (the full schema chain + schema-platform.sql, no seed data —
// this suite inserts everything it needs). Mounts the real
// routers with a stub auth keyed by the x-test-user header,
// following e2e-tasks-test.js.
//
//   PGHOST=/tmp/pgtest PGPORT=54399 PGUSER=postgres \
//   PGDATABASE=caretask_demo node e2e-platform-test.js
const express = require('express');
const pool = require('./db');
const patientsRouter = require('./routes/patients');
const appointmentsRouter = require('./routes/appointments');
const episodesRouter = require('./routes/episodes');
const invitesRouter = require('./routes/invites');
const usersRouter = require('./routes/users');

const PORT = 3118;
const BASE = `http://127.0.0.1:${PORT}`;

const USERS = {
  admin: { uid: 'pf-admin-uid', email: 'padmin@example.com' },
  pt: { uid: 'pf-pt-uid', email: 'pt@example.com' },
  pta: { uid: 'pf-pta-uid', email: 'pta@example.com' },
  cov: { uid: 'pf-cov-uid', email: 'cov@example.com' },
  other: { uid: 'pf-other-uid', email: 'other@example.com' },
  newbie: { uid: 'pf-newbie-uid', email: 'newbie@example.com' },
  late: { uid: 'pf-late-uid', email: 'late@example.com' },
  ghost: { uid: 'pf-ghost-uid', email: 'ghost@example.com' },
};

function stubAuth(req, res, next) {
  const who = USERS[req.headers['x-test-user']] || USERS.pt;
  req.user = { uid: who.uid, email: who.email };
  next();
}

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
  if (ok) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.log(`  FAIL - ${name}${extra ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

async function call(method, path, { as = 'pt', body } = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-test-user': as };
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
}

const ids = {};

async function setup() {
  const staff = [
    ['admin', 'admin', 'Ann', 'Admin'],
    ['pt', 'clinician', 'Pat', 'Therapist'],
    ['pta', 'clinician', 'Pam', 'Assistant'],
    ['cov', 'clinician', 'Cal', 'Cover'],
    ['other', 'clinician', 'Ola', 'Outsider'],
  ];
  for (const [key, role, fname, lname] of staff) {
    const r = await pool.query(
      `INSERT INTO users (firebase_uid, email, role, fname, lname, authorized, active)
       VALUES ($1, $2, $3, $4, $5, true, true) RETURNING id`,
      [USERS[key].uid, USERS[key].email, role, fname, lname],
    );
    ids[key] = r.rows[0].id;
  }
  const agA = await pool.query(
    `INSERT INTO agencies (license_number, name, city) VALUES ('PF-A', 'Alpha Home Health', 'Chicago') RETURNING id`,
  );
  const agB = await pool.query(
    `INSERT INTO agencies (license_number, name, city) VALUES ('PF-B', 'Beta Care Agency', 'Oak Lawn') RETURNING id`,
  );
  ids.agencyA = agA.rows[0].id;
  ids.agencyB = agB.rows[0].id;
  for (const [user, agency] of [
    ['pt', 'agencyA'],
    ['pta', 'agencyA'],
    ['cov', 'agencyA'],
    ['other', 'agencyB'],
  ]) {
    await pool.query(
      'INSERT INTO user_agencies (user_id, agency_id) VALUES ($1, $2)',
      [ids[user], ids[agency]],
    );
  }
  await pool.query(
    `INSERT INTO appointment_categories (name, color, cattype, default_duration_min)
     VALUES ('Revisit', '#2563eb', 'appointment', 45),
            ('Initial Evaluation', '#0d9488', 'appointment', 60),
            ('Resumption of Care', '#0891b2', 'appointment', 60),
            ('In Office', '#16a34a', 'provider', 480)`,
  );
  const cat = await pool.query(
    `SELECT id, name FROM appointment_categories WHERE name IN ('Revisit', 'In Office', 'Resumption of Care')`,
  );
  for (const row of cat.rows) {
    ids[
      row.name === 'Revisit'
        ? 'catRevisit'
        : row.name === 'Resumption of Care'
          ? 'catRoc'
          : 'catOffice'
    ] = row.id;
  }
  await pool.query(
    `INSERT INTO appointment_statuses (code, label, color, sort_order) VALUES
       ('scheduled', 'Scheduled', '#d97706', 1),
       ('completed', 'Completed', '#16a34a', 2),
       ('missed', 'Missed', '#dc2626', 3),
       ('cancelled', 'Cancelled', '#64748b', 4)
     ON CONFLICT (code) DO NOTHING`,
  );
}

const ANA = {
  fname: 'Ana',
  lname: 'Reyes',
  date_of_birth: '1950-01-02',
  phone_cell: '708-555-0111',
  city: 'Justice',
};

async function main() {
  await setup();
  const app = express();
  app.use(express.json());
  app.use('/patients', stubAuth, patientsRouter);
  app.use('/appointments', stubAuth, appointmentsRouter);
  app.use('/users', stubAuth, usersRouter);
  app.use('/invites', stubAuth, invitesRouter);
  app.use('/', stubAuth, episodesRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: 'internal', detail: String(err && err.message) }));
  const server = app.listen(PORT);
  try {
    console.log('staff gate:');
    let r = await call('GET', '/patients', { as: 'ghost' });
    check('no staff record -> 403 NO_STAFF_RECORD on list', r.res.status === 403 && r.json.code === 'NO_STAFF_RECORD', r.json);
    r = await call('POST', '/patients', { as: 'ghost', body: ANA });
    check('no staff record -> 403 NO_STAFF_RECORD on create', r.res.status === 403 && r.json.code === 'NO_STAFF_RECORD', r.json);

    console.log('create + scoping:');
    r = await call('POST', '/patients', { as: 'pt', body: { ...ANA, agency_id: ids.agencyA } });
    check('pt creates Ana -> 201', r.res.status === 201, r.json);
    ids.ana = r.json.id;
    r = await call('GET', '/patients', { as: 'pt' });
    check('creator list contains Ana (auto-link)', r.json.some((p) => p.id === ids.ana), r.json.length);
    r = await call('GET', '/patients', { as: 'pta' });
    check('pta list is empty (blank workspace)', r.json.length === 0, r.json.length);
    r = await call('GET', `/patients/${ids.ana}`, { as: 'pta' });
    check('pta cannot open Ana (404, existence hidden)', r.res.status === 404, r.res.status);
    r = await call('GET', '/patients?all=1', { as: 'admin' });
    check('admin registry view sees Ana', r.res.status === 200 && r.json.some((p) => p.id === ids.ana), r.res.status);
    r = await call('GET', '/patients?all=1', { as: 'pt' });
    check('non-admin registry view refused', r.res.status === 403 && r.json.code === 'ADMIN_REQUIRED', r.json);

    console.log('duplicate rules:');
    r = await call('POST', '/patients', { as: 'other', body: ANA });
    check('exact duplicate -> 409 PATIENT_EXISTS', r.res.status === 409 && r.json.code === 'PATIENT_EXISTS', r.json);
    check('exact duplicate names the record + not linked', r.json.patient && r.json.patient.id === ids.ana && r.json.patient.already_linked === false, r.json.patient);
    r = await call('POST', `/patients/${ids.ana}/link`, { as: 'other' });
    check('link instead -> 200 linked', r.res.status === 200 && r.json.linked === true, r.json);
    r = await call('GET', `/patients/${ids.ana}`, { as: 'other' });
    check('after linking, other can open Ana', r.res.status === 200, r.res.status);
    r = await call('POST', '/patients', {
      as: 'pt',
      body: { fname: 'Ana', lname: 'Reyez', date_of_birth: '1950-01-02' },
    });
    check('near match -> 409 POSSIBLE_MATCH', r.res.status === 409 && r.json.code === 'POSSIBLE_MATCH', r.json);
    check('near match offers Ana as candidate', Array.isArray(r.json.candidates) && r.json.candidates.some((c) => c.id === ids.ana), r.json.candidates);
    r = await call('POST', '/patients', {
      as: 'pt',
      body: { fname: 'Ana', lname: 'Reyez', date_of_birth: '1950-01-02', confirm_create: true },
    });
    check('confirm_create overrides the prompt -> 201', r.res.status === 201, r.json);
    ids.reyez = r.json.id;

    console.log('known non-duplicate:');
    r = await call('DELETE', `/patients/${ids.reyez}`, { as: 'admin' });
    check('manager soft-deletes the confirmed patient', r.res.status === 204, r.res.status);
    r = await call('POST', '/patients', {
      as: 'pt',
      body: { fname: 'Ana', lname: 'Reyez', date_of_birth: '1950-01-02' },
    });
    check('same intake no longer prompts (KND) -> 201', r.res.status === 201, r.json && r.json.code);
    ids.reyez = r.json.id;

    console.log('link status + unlink:');
    r = await call('PUT', `/patients/${ids.ana}/link`, { as: 'pt', body: { list_status: 'hold' } });
    check('link status -> hold', r.res.status === 200 && r.json.list_status === 'hold', r.json);
    r = await call('GET', '/patients?status=hold', { as: 'pt' });
    check('list filtered by link status (hold)', r.json.some((p) => p.id === ids.ana && p.status === 'hold'), r.json.map((p) => p.status));
    r = await call('PUT', `/patients/${ids.ana}/link`, { as: 'pt', body: { list_status: 'active' } });
    check('link status back to active', r.res.status === 200 && r.json.list_status === 'active', r.json);
    r = await call('DELETE', `/patients/${ids.ana}/link`, { as: 'other' });
    check('other unlinks Ana', r.res.status === 200 && r.json.linked === false, r.json);
    r = await call('GET', `/patients/${ids.ana}`, { as: 'other' });
    check('after unlink, other loses the chart (404)', r.res.status === 404, r.res.status);

    console.log('episodes:');
    r = await call('POST', `/patients/${ids.ana}/episodes`, { as: 'pt', body: { agency_id: ids.agencyB } });
    check('episode at an agency I do not work for -> 403 NOT_AGENCY_MEMBER', r.res.status === 403 && r.json.code === 'NOT_AGENCY_MEMBER', r.json);
    r = await call('POST', `/patients/${ids.ana}/episodes`, { as: 'pt', body: { agency_id: ids.agencyA } });
    check('pt starts episode at Alpha -> 201', r.res.status === 201, r.json);
    ids.episode = r.json.episode.id;
    check('episode names agency + primary', r.json.episode.agency_name === 'Alpha Home' && Number(r.json.episode.primary_user_id) === Number(ids.pt), r.json.episode);
    r = await call('POST', `/patients/${ids.ana}/link`, { as: 'other' });
    check('other re-links Ana', r.res.status === 200, r.json);
    r = await call('POST', `/patients/${ids.ana}/episodes`, { as: 'other', body: { agency_id: ids.agencyB } });
    check('second active episode -> 409 EPISODE_ACTIVE', r.res.status === 409 && r.json.code === 'EPISODE_ACTIVE', r.json);
    check('conflict names holding agency + primary', r.json.episode && r.json.episode.agency_name === 'Alpha Home' && /Pat/.test(r.json.episode.primary_name || ''), r.json.episode);
    r = await call('POST', `/episodes/${ids.episode}/members`, { as: 'pt', body: { user_id: ids.other } });
    check('adding a non-agency colleague -> 400 NOT_AGENCY_MEMBER', r.res.status === 400 && r.json.code === 'NOT_AGENCY_MEMBER', r.json);
    r = await call('POST', `/episodes/${ids.episode}/members`, { as: 'pt', body: { user_id: ids.pta, supervised_by: ids.pt } });
    check('pt adds pta to the team -> 201', r.res.status === 201 && r.json.members.some((m) => Number(m.user_id) === Number(ids.pta)), r.json);
    r = await call('GET', '/patients', { as: 'pta' });
    check('added member is auto-linked (pta sees Ana)', r.json.some((p) => p.id === ids.ana), r.json.length);
    r = await call('DELETE', `/episodes/${ids.episode}/members/${ids.pt}`, { as: 'pt' });
    check('primary cannot be removed -> 400', r.res.status === 400 && r.json.code === 'CANNOT_REMOVE_PRIMARY', r.json);
    r = await call('DELETE', '/users/me/agencies/' + ids.agencyA, { as: 'pt' });
    check('primary cannot leave agency mid-episode -> 409', r.res.status === 409 && r.json.code === 'PRIMARY_ON_ACTIVE_EPISODE', r.json);

    console.log('booking gate:');
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const dayAfter = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    r = await call('POST', '/appointments', {
      as: 'pta',
      body: { patient_id: ids.ana, provider_id: ids.pta, category_id: ids.catRevisit, starts_at: tomorrow, ends_at: new Date(Date.now() + 24 * 3600 * 1000 + 45 * 60000).toISOString() },
    });
    check('team member books own visit -> 201 + episode stamped', r.res.status === 201 && r.json.appointment.episode_id === ids.episode, r.json);
    r = await call('POST', '/appointments', {
      as: 'pt',
      body: { patient_id: ids.ana, provider_id: ids.other, category_id: ids.catRevisit, starts_at: tomorrow, ends_at: new Date(Date.now() + 24 * 3600 * 1000 + 45 * 60000).toISOString() },
    });
    check('booking an outsider -> 403 NOT_ON_TEAM', r.res.status === 403 && r.json.code === 'NOT_ON_TEAM', r.json);
    r = await call('POST', '/appointments', {
      as: 'pt',
      body: { patient_id: ids.ana, provider_id: ids.cov, category_id: ids.catRevisit, starts_at: dayAfter, ends_at: new Date(Date.now() + 48 * 3600 * 1000 + 45 * 60000).toISOString() },
    });
    check('agency colleague covers a single visit -> 201', r.res.status === 201 && r.json.appointment.episode_id === ids.episode, r.json);
    r = await call('GET', `/patients/${ids.ana}`, { as: 'cov' });
    check('covering clinician gets chart access around the visit', r.res.status === 200, r.res.status);
    r = await call('GET', '/patients', { as: 'cov' });
    check('covering clinician does NOT get the patient on their list', !r.json.some((p) => p.id === ids.ana), r.json.length);
    const seriesVisits = [0, 2, 4, 7].map((d) => new Date(Date.now() + (72 + d * 24) * 3600 * 1000).toISOString());
    r = await call('POST', '/appointments/series', {
      as: 'pt',
      body: { patient_id: ids.ana, provider_id: ids.cov, category_id: ids.catRevisit, duration_min: 45, visits: seriesVisits },
    });
    check('series for a covering (non-team) provider -> 403 NOT_ON_TEAM', r.res.status === 403 && r.json.code === 'NOT_ON_TEAM', r.json);
    r = await call('POST', '/appointments/series', {
      as: 'pt',
      body: { patient_id: ids.ana, provider_id: ids.pta, category_id: ids.catRevisit, duration_min: 45, visits: seriesVisits },
    });
    check('series for a team member -> 201, all stamped', r.res.status === 201 && r.json.appointments.length === 4 && r.json.appointments.every((a) => a.episode_id === ids.episode), r.json && r.json.appointments && r.json.appointments.length);
    r = await call('POST', '/patients', { as: 'pt', body: { fname: 'No', lname: 'Episode', date_of_birth: '1960-05-05' } });
    ids.noEp = r.json.id;
    r = await call('POST', '/appointments', {
      as: 'pt',
      body: { patient_id: ids.noEp, provider_id: ids.pt, category_id: ids.catRevisit, starts_at: tomorrow, ends_at: new Date(Date.now() + 24 * 3600 * 1000 + 45 * 60000).toISOString() },
    });
    check('solo mode: booking without an episode -> 201, unstamped (personal visit)', r.res.status === 201 && r.json.appointment.episode_id === null, r.json);
    r = await call('POST', '/appointments/series', {
      as: 'pt',
      body: { patient_id: ids.noEp, provider_id: ids.pt, category_id: ids.catRevisit, duration_min: 45, visits: seriesVisits },
    });
    check('solo mode: a series without an episode -> 201, all unstamped', r.res.status === 201 && r.json.appointments.length === 4 && r.json.appointments.every((a) => a.episode_id === null), r.json && r.json.appointments && r.json.appointments.length);

    console.log('calendar scopes:');
    const range = `?from=${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 30 * 86400000).toISOString())}`;
    r = await call('GET', `/appointments${range}`, { as: 'pta' });
    check('personal calendar: pta sees own visits', r.json.appointments.length > 0 && r.json.appointments.every((a) => Number(a.provider_id) === Number(ids.pta)), r.json.appointments.map((a) => a.provider_id));
    r = await call('GET', `/appointments${range}&patient_id=${ids.ana}`, { as: 'pta' });
    check('master calendar: pta sees the whole team\'s visits for Ana', r.json.appointments.some((a) => Number(a.provider_id) === Number(ids.cov)) && r.json.appointments.length >= 6, r.json.appointments.length);
    r = await call('GET', `/appointments${range}&patient_id=${ids.ana}`, { as: 'other' });
    check('master calendar still open to a linked non-team user', r.res.status === 200, r.res.status);
    r = await call('DELETE', `/patients/${ids.ana}/link`, { as: 'other' });
    r = await call('GET', `/appointments${range}&patient_id=${ids.ana}`, { as: 'other' });
    check('master calendar closed after unlink (404)', r.res.status === 404, r.res.status);
    r = await call('GET', `/appointments${range}&scope=all`, { as: 'pt' });
    check('scope=all refused for a clinician', r.res.status === 403 && r.json.code === 'SCOPE_FORBIDDEN', r.json);
    r = await call('GET', `/appointments${range}&scope=all`, { as: 'admin' });
    check('scope=all works for admin', r.res.status === 200 && r.json.appointments.length >= 6, r.json && r.json.appointments && r.json.appointments.length);

    console.log('discharge + transfer + recertify:');
    r = await call('POST', `/episodes/${ids.episode}/discharge`, { as: 'pta', body: {} });
    check('team member who is not primary cannot discharge', r.res.status === 403 && r.json.code === 'ROLE_REQUIRED', r.json);
    r = await call('POST', `/episodes/${ids.episode}/discharge`, { as: 'pt', body: { discharge_note: 'Goals met' } });
    check('primary discharges -> 200 discharged', r.res.status === 200 && r.json.episode.status === 'discharged', r.json);
    r = await call('POST', `/patients/${ids.ana}/link`, { as: 'other' });
    r = await call('POST', `/patients/${ids.ana}/episodes`, { as: 'other', body: { agency_id: ids.agencyB } });
    check('after discharge, transfer episode opens at Beta', r.res.status === 201 && Number(r.json.episode.primary_user_id) === Number(ids.other), r.json);
    ids.episodeB = r.json.episode.id;
    r = await call('POST', `/episodes/${ids.episodeB}/recertify`, { as: 'other', body: {} });
    check('recertify opens a chained episode, team copied', r.res.status === 201 && r.json.episode.recert_of === ids.episodeB && r.json.episode.members.some((m) => Number(m.user_id) === Number(ids.other) && m.member_role === 'primary'), r.json);
    r = await call('GET', `/patients/${ids.ana}/episodes`, { as: 'other' });
    check('episode history lists all three episodes', r.res.status === 200 && r.json.episodes.length === 3, r.json && r.json.episodes && r.json.episodes.length);

    console.log('invites:');
    r = await call('POST', '/invites', { as: 'pt', body: { email: 'newbie@example.com' } });
    check('non-admin cannot create invites', r.res.status === 403, r.res.status);
    r = await call('POST', '/invites', { as: 'admin', body: { email: 'newbie@example.com' } });
    check('admin creates invite -> code returned once', r.res.status === 201 && typeof r.json.code === 'string' && r.json.code.length >= 16, r.json);
    const code = r.json.code;
    r = await call('POST', '/invites/accept', { as: 'other', body: { code } });
    check('accept with the wrong email -> 403 INVITE_EMAIL_MISMATCH', r.res.status === 403 && r.json.code === 'INVITE_EMAIL_MISMATCH', r.json);
    r = await call('POST', '/invites/accept', { as: 'newbie', body: { code, fname: 'New', lname: 'Clinician' } });
    check('invitee accepts -> staff record provisioned', r.res.status === 201 && r.json.staff && r.json.staff.role === 'clinician' && r.json.staff.email === 'newbie@example.com', r.json);
    r = await call('GET', '/patients', { as: 'newbie' });
    check('new workspace is blank', r.res.status === 200 && r.json.length === 0, r.json && r.json.length);
    r = await call('POST', '/invites/accept', { as: 'newbie', body: { code } });
    check('re-accepting a used invite -> 409 INVITE_USED', r.res.status === 409 && r.json.code === 'INVITE_USED', r.json);
    r = await call('POST', '/invites', { as: 'admin', body: { email: 'second@example.com' } });
    const invite2Id = r.json.invite.id;
    const code2 = r.json.code;
    r = await call('DELETE', `/invites/${invite2Id}`, { as: 'admin' });
    check('admin revokes invite', r.res.status === 200 && r.json.invite.status === 'revoked', r.json);
    r = await call('POST', '/invites/accept', { as: 'late', body: { code: code2 } });
    check('revoked invite cannot be accepted', r.res.status === 404 && r.json.code === 'INVITE_INVALID', r.json);
    const { createHash } = require('node:crypto');
    await pool.query(
      `INSERT INTO invites (email, role, code_hash, expires_at)
       VALUES ('late@example.com', 'clinician', $1, now() - interval '1 day')`,
      [createHash('sha256').update('expired-code').digest('hex')],
    );
    r = await call('POST', '/invites/accept', { as: 'late', body: { code: 'expired-code' } });
    check('expired invite -> 400 INVITE_EXPIRED', r.res.status === 400 && r.json.code === 'INVITE_EXPIRED', r.json);

    console.log('directory + my agencies:');
    r = await call('GET', '/users/clinicians', { as: 'pt' });
    check('clinicians list = agency colleagues', r.json.some((u) => u.email === 'pta@example.com') && r.json.some((u) => u.email === 'cov@example.com') && !r.json.some((u) => u.email === 'other@example.com'), r.json.map((u) => u.email));
    r = await call('GET', '/users/me/agencies', { as: 'pta' });
    check('my agencies lists Alpha for pta', r.res.status === 200 && r.json.agencies.some((a) => a.display_name === 'Alpha Home'), r.json);
    r = await call('POST', '/users/me/agencies', { as: 'pta', body: { agency_id: ids.agencyB } });
    check('pta joins Beta', r.res.status === 201, r.json);
    r = await call('DELETE', '/users/me/agencies/' + ids.agencyB, { as: 'pta' });
    check('pta leaves Beta', r.res.status === 200 && r.json.removed === true, r.json);

    console.log('holds + discharge reasons + case manager (addendum):');
    r = await call('POST', '/patients', { as: 'pt', body: { fname: 'Hal', lname: 'Holden', date_of_birth: '1948-03-04' } });
    check('pt creates Hal -> 201', r.res.status === 201, r.json);
    ids.hal = r.json.id;
    r = await call('POST', `/patients/${ids.hal}/episodes`, { as: 'pt', body: { agency_id: ids.agencyA } });
    check('episode opens for Hal -> 201', r.res.status === 201, r.json);
    ids.epHal = r.json.episode.id;
    check('case manager defaults to the primary', Number(r.json.episode.case_manager_user_id) === Number(ids.pt) && /Pat/.test(r.json.episode.case_manager_name || ''), r.json.episode);
    r = await call('POST', `/episodes/${ids.epHal}/members`, { as: 'pt', body: { user_id: ids.pta } });
    check('pta joins Hal\'s team', r.res.status === 201, r.json);
    r = await call('PUT', `/episodes/${ids.epHal}/case-manager`, { as: 'pt', body: { user_id: ids.cov } });
    check('case manager must be on the team -> 400 NOT_ON_TEAM', r.res.status === 400 && r.json.code === 'NOT_ON_TEAM', r.json);
    r = await call('PUT', `/episodes/${ids.epHal}/case-manager`, { as: 'pt', body: { user_id: ids.pta } });
    check('case management hands off to pta', r.res.status === 200 && Number(r.json.episode.case_manager_user_id) === Number(ids.pta), r.json);
    r = await call('DELETE', `/episodes/${ids.epHal}/members/${ids.pta}`, { as: 'pt' });
    check('case manager cannot be removed before a handoff -> 400', r.res.status === 400 && r.json.code === 'CANNOT_REMOVE_CASE_MANAGER', r.json);
    r = await call('POST', `/episodes/${ids.epHal}/hold`, { as: 'pta', body: { reason: 'hospitalized', note: 'St. Mary Hospital' } });
    check('case manager (not primary) puts the episode on hold', r.res.status === 200 && r.json.episode.status === 'on_hold' && r.json.episode.current_hold && r.json.episode.current_hold.reason === 'hospitalized', r.json);
    r = await call('POST', `/episodes/${ids.epHal}/hold`, { as: 'pt', body: { reason: 'other' } });
    check('double hold -> 409 ALREADY_ON_HOLD', r.res.status === 409 && r.json.code === 'ALREADY_ON_HOLD', r.json);
    r = await call('POST', `/patients/${ids.hal}/link`, { as: 'other' });
    r = await call('POST', `/patients/${ids.hal}/episodes`, { as: 'other', body: { agency_id: ids.agencyB } });
    check('held episode still blocks another agency (status named)', r.res.status === 409 && r.json.code === 'EPISODE_ACTIVE' && r.json.episode.status === 'on_hold', r.json);
    r = await call('POST', '/appointments', {
      as: 'pt',
      body: { patient_id: ids.hal, provider_id: ids.pt, category_id: ids.catRevisit, starts_at: tomorrow, ends_at: new Date(Date.now() + 24 * 3600 * 1000 + 45 * 60000).toISOString() },
    });
    check('booking a regular visit on hold -> 409 EPISODE_ON_HOLD', r.res.status === 409 && r.json.code === 'EPISODE_ON_HOLD', r.json);
    r = await call('POST', '/appointments/series', {
      as: 'pt',
      body: { patient_id: ids.hal, provider_id: ids.pta, category_id: ids.catRoc, duration_min: 60, visits: seriesVisits },
    });
    check('even an ROC series stays refused on hold -> 409', r.res.status === 409 && r.json.code === 'EPISODE_ON_HOLD', r.json);
    r = await call('POST', '/appointments', {
      as: 'pta',
      body: { patient_id: ids.hal, provider_id: ids.pta, category_id: ids.catRoc, starts_at: dayAfter, ends_at: new Date(Date.now() + 48 * 3600 * 1000 + 60 * 60000).toISOString() },
    });
    check('booking a Resumption of Care visit -> 201 + episode stamped', r.res.status === 201 && r.json.appointment.episode_id === ids.epHal, r.json);
    r = await call('GET', `/patients/${ids.hal}/episodes`, { as: 'pt' });
    check('the ROC booking ended the hold (episode active again)', r.res.status === 200 && r.json.episodes[0].status === 'active', r.json && r.json.episodes && r.json.episodes[0] && r.json.episodes[0].status);
    r = await call('POST', `/episodes/${ids.epHal}/resume`, { as: 'pt', body: {} });
    check('resume when not on hold -> 409 NOT_ON_HOLD', r.res.status === 409 && r.json.code === 'NOT_ON_HOLD', r.json);
    r = await call('POST', `/episodes/${ids.epHal}/hold`, { as: 'pt', body: { reason: 'hospitalized' } });
    check('episode holds a second time', r.res.status === 200 && r.json.episode.status === 'on_hold', r.json);
    r = await call('POST', `/episodes/${ids.epHal}/recertify`, { as: 'pt', body: {} });
    check('recertify on hold -> 409 EPISODE_ON_HOLD', r.res.status === 409 && r.json.code === 'EPISODE_ON_HOLD', r.json);
    r = await call('POST', `/episodes/${ids.epHal}/discharge`, { as: 'pta', body: { discharge_reason: 'transferred_inpatient', discharge_note: 'Did not return home' } });
    check('case manager discharges from hold, reason recorded', r.res.status === 200 && r.json.episode.status === 'discharged' && r.json.episode.discharge_reason === 'transferred_inpatient', r.json);
    r = await call('POST', `/patients/${ids.hal}/episodes`, { as: 'pt', body: { agency_id: ids.agencyA } });
    check('a fresh episode opens after the discharge', r.res.status === 201, r.json);
    ids.epHal2 = r.json.episode.id;
    r = await call('POST', `/episodes/${ids.epHal2}/discharge`, { as: 'pt', body: { discharge_reason: 'bogus' } });
    check('unknown discharge reason -> 400 VALIDATION', r.res.status === 400 && r.json.code === 'VALIDATION', r.json);
    r = await call('POST', `/episodes/${ids.epHal2}/discharge`, { as: 'pt', body: { discharge_reason: 'completed' } });
    check('discharge with reason completed -> 200', r.res.status === 200 && r.json.episode.discharge_reason === 'completed', r.json);

    console.log('solo mode gate engagement:');
    r = await call('POST', `/patients/${ids.noEp}/episodes`, { as: 'pt', body: { agency_id: ids.agencyA } });
    check('an episode can start later for the solo patient', r.res.status === 201, r.json);
    r = await call('POST', '/appointments', {
      as: 'pt',
      body: { patient_id: ids.noEp, provider_id: ids.other, category_id: ids.catRevisit, starts_at: tomorrow, ends_at: new Date(Date.now() + 24 * 3600 * 1000 + 45 * 60000).toISOString() },
    });
    check('once an episode exists, the team gate engages -> 403 NOT_ON_TEAM', r.res.status === 403 && r.json.code === 'NOT_ON_TEAM', r.json);
    r = await call('POST', '/appointments', {
      as: 'pt',
      body: { patient_id: ids.noEp, provider_id: ids.pt, category_id: ids.catRevisit, starts_at: tomorrow, ends_at: new Date(Date.now() + 24 * 3600 * 1000 + 45 * 60000).toISOString() },
    });
    check('and team bookings stamp the episode as before', r.res.status === 201 && r.json.appointment.episode_id != null, r.json);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    server.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
