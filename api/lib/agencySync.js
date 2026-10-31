// IDPH Home Health Agency Directory sync — imports the Illinois
// open-data directory into the agencies table (schema-agencies.sql).
//
// Source (verified live 2026-10-30, see
// ../agency-directory-research.md):
//   Dataset  IDPH Home Health Agency Directory
//   ID       p7mg-cnpx
//   Domain   illinois-edp.data.socrata.com (Socrata)
//   Rows     595 at verification time
//   Updated  irregularly; rowsUpdatedAt 2026-04-28T17:13:30Z then
//
// How a sync runs:
// 1. Read the dataset metadata (api/views/<id>) for rowsUpdatedAt.
//    If it matches the source_updated_at of the last successful
//    (non-skipped) sync recorded in event_log, the IDPH pass is
//    skipped. This is what makes a weekly timer cheap and polite.
// 2. Otherwise page the resource endpoint ($limit/$offset) and
//    upsert every row on license_number, updating SOURCE fields
//    only. Local fields (is_primary, notes) are never in the SET
//    list, so a sync can never clobber them.
// 3. Agencies whose license_number is absent from the snapshot
//    are marked active = false — deactivated, never deleted.
// 4. CMS enrichment pass (fetchCmsIlRows / runCmsEnrichment):
//    fetch the CMS Illinois subset and attach service lines,
//    star rating, CCN, ownership and cert date to matched
//    agencies (phone+ZIP, then name+ZIP; unambiguous only).
//    Runs on every sync; a CMS failure aborts only this pass
//    and is recorded as cms_error in the event details.
// 5. Exactly ONE agency_sync event is written per run (this lib
//    is the single logging point — the API route and the CLI both
//    call syncAgencies and neither logs again). Details are
//    counts + source stamp only, never agency row content.
//
// fetch is injectable (opts.fetchImpl) and a run can be fed sample
// rows directly (opts.sampleRows + opts.sampleSourceUpdatedAt,
// opts.sampleCmsRows for the CMS pass), so tests and the CLI's
// --sample mode need no live network.
const { insertEvent } = require('./eventLog');

const DATASET_ID = 'p7mg-cnpx';
const DOMAIN = 'illinois-edp.data.socrata.com';
const RESOURCE_URL = `https://${DOMAIN}/resource/${DATASET_ID}.json`;
const METADATA_URL = `https://${DOMAIN}/api/views/${DATASET_ID}`;
const PAGE_SIZE = 50000;
const SOURCE = 'idph';

// --- CMS Provider Data enrichment (second pass of the same
// sync). Dataset "Home Health Care Agencies" (data.cms.gov
// Provider Data Catalog, id 6jpm-sxkc) carries what IDPH does
// not publish: service lines (Yes/No per discipline), the CMS
// quality-of-patient-care star rating, CCN, ownership and
// certification date. Endpoint + field names verified live
// 2026-10-30 — see ../agency-directory-research.md (addendum).
const CMS_DATASET_ID = '6jpm-sxkc';
const CMS_QUERY_URL =
  `https://data.cms.gov/provider-data/api/1/datastore/query/${CMS_DATASET_ID}/0`;
const CMS_PAGE_SIZE = 500;

// Page the CMS datastore query API for the Illinois subset.
// Property names are the API's own (verified, see research
// note). limit must be >= 1; the response carries `count`.
// data.cms.gov sits behind a bot filter that 403s non-browser
// user agents (verified 2026-10-30: Node's default UA → 403,
// a browser UA → 200). Identify as a browser + name the app in
// an accept header; the API itself needs no key.
const CMS_FETCH_HEADERS = {
  'content-type': 'application/json',
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  accept: 'application/json',
};

async function fetchCmsIlRows(fetchImpl) {
  const rows = [];
  for (let offset = 0; ; offset += CMS_PAGE_SIZE) {
    const res = await fetchImpl(CMS_QUERY_URL, {
      method: 'POST',
      headers: CMS_FETCH_HEADERS,
      body: JSON.stringify({
        conditions: [{ property: 'state', value: 'IL', operator: '=' }],
        limit: CMS_PAGE_SIZE,
        offset,
        count: true,
        results: true,
        keys: true,
        format: 'json',
        rowIds: false,
      }),
    });
    if (!res || !res.ok) {
      throw new Error(`CMS fetch failed (${res ? res.status : 'no response'})`);
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.results)) {
      throw new Error('CMS datastore response did not carry a results array');
    }
    rows.push(...data.results);
    const total = typeof data.count === 'number' ? data.count : rows.length;
    if (rows.length >= total || data.results.length === 0) break;
  }
  return rows;
}

function yesNo(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'yes') return true;
  if (s === 'no') return false;
  return null;
}

// One raw CMS row → the agencies CMS columns + the keys the
// matcher needs. Star rating arrives as a string ("4.5"); the
// literal "-" means CMS does not rate the agency → NULL.
function cmsMapRow(r) {
  if (!r || typeof r !== 'object') return null;
  const ratingRaw = typeof r.quality_of_patient_care_star_rating === 'string'
    ? r.quality_of_patient_care_star_rating.trim()
    : '';
  const rating = /^\d+(\.\d+)?$/.test(ratingRaw) ? Number(ratingRaw) : null;
  let certDate = null;
  const cd = typeof r.certification_date === 'string'
    ? r.certification_date.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
    : null;
  if (cd) certDate = `${cd[3]}-${cd[1]}-${cd[2]}`;
  return {
    ccn: (r.cms_certification_number_ccn || '').trim() || null,
    provider_name: typeof r.provider_name === 'string' ? r.provider_name : '',
    phone_digits: digitsOnly(r.telephone_number),
    zip: (r.zip_code || '').trim() || null,
    offers_nursing: yesNo(r.offers_nursing_care_services),
    offers_pt: yesNo(r.offers_physical_therapy_services),
    offers_ot: yesNo(r.offers_occupational_therapy_services),
    offers_speech: yesNo(r.offers_speech_pathology_services),
    offers_msw: yesNo(r.offers_medical_social_services),
    offers_hha: yesNo(r.offers_home_health_aide_services),
    star_rating: rating,
    cms_ownership: (r.type_of_ownership || '').trim() || null,
    cms_cert_date: certDate,
  };
}

function digitsOnly(p) {
  const d = String(p || '').replace(/\D/g, '');
  // Tolerate a leading US country code.
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

// Name comparison key: uppercase, punctuation → space, legal
// suffixes (LLC / INC / CORP / CO / …) stripped repeatedly.
// "Test Beta Care, Inc." → "TEST BETA CARE".
function normalizeAgencyName(name) {
  let s = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const SUFFIX = /\s+(LLC|INC|CORP|CORPORATION|CO|COMPANY|LTD|LP|LLP)$/;
  while (SUFFIX.test(s)) s = s.replace(SUFFIX, '').trim();
  return s;
}

// The names an agency can be matched under: its full IDPH
// name, its legal name with any embedded DBA removed, and the
// DBA itself (CMS often lists the trade name).
function agencyNameKeys(row) {
  const keys = new Set();
  const full = normalizeAgencyName(row.name);
  if (full) keys.add(full);
  const dba = (row.dba || '').trim() || parseDba(row.name || '');
  if (dba) {
    const dbaKey = normalizeAgencyName(dba);
    if (dbaKey) keys.add(dbaKey);
    const legal = normalizeAgencyName(
      String(row.name || '').replace(/\s+-\s+DBA\s+.+$/i, ''),
    );
    if (legal) keys.add(legal);
  }
  return keys;
}

// Match CMS rows to agency rows. No shared key exists (IDPH
// license # vs CMS CCN), so: primary = phone digits AND zip
// equal; secondary = normalized name AND zip equal. A CMS row
// attaches only when exactly ONE agency candidate remains —
// ambiguity is a skip, never a guess. Returns a Map of
// agency id → mapped CMS row, plus the unmatched CMS count.
function matchCmsRows(agencyRows, cmsRows) {
  const prepared = agencyRows.map((a) => ({
    id: a.id,
    phone_digits: digitsOnly(a.phone),
    zip: (a.postal_code || '').trim(),
    nameKeys: agencyNameKeys(a),
  }));
  const updates = new Map();
  let unmatched = 0;
  for (const cms of cmsRows) {
    let candidates = [];
    if (cms.phone_digits && cms.zip) {
      candidates = prepared.filter(
        (a) => a.phone_digits && a.phone_digits === cms.phone_digits && a.zip === cms.zip,
      );
    }
    if (candidates.length === 0 && cms.zip) {
      const key = normalizeAgencyName(cms.provider_name);
      if (key) {
        candidates = prepared.filter(
          (a) => a.zip === cms.zip && a.nameKeys.has(key),
        );
      }
    }
    if (candidates.length === 1) {
      updates.set(candidates[0].id, cms);
    } else {
      unmatched += 1;
    }
  }
  return { updates, matched: updates.size, unmatched };
}

const CMS_UPDATE_SQL = `
  UPDATE agencies SET
    ccn = $2, offers_nursing = $3, offers_pt = $4, offers_ot = $5,
    offers_speech = $6, offers_msw = $7, offers_hha = $8,
    star_rating = $9, cms_ownership = $10, cms_cert_date = $11,
    cms_matched_at = now()
  WHERE id = $1`;

// The enrichment pass itself: match + write in one transaction
// on the caller's pool. CMS columns only — IDPH source fields
// and local fields are not in the UPDATE.
async function runCmsEnrichment(db, rawCmsRows) {
  const cmsRows = rawCmsRows.map(cmsMapRow).filter(Boolean);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const agencies = await client.query(
      'SELECT id, name, dba, phone, postal_code FROM agencies',
    );
    const { updates, unmatched } = matchCmsRows(agencies.rows, cmsRows);
    for (const [id, cms] of updates) {
      await client.query(CMS_UPDATE_SQL, [
        id, cms.ccn, cms.offers_nursing, cms.offers_pt, cms.offers_ot,
        cms.offers_speech, cms.offers_msw, cms.offers_hha,
        cms.star_rating, cms.cms_ownership, cms.cms_cert_date,
      ]);
    }
    await client.query('COMMIT');
    return {
      cms_rows: cmsRows.length,
      cms_matched: updates.size,
      cms_unmatched: unmatched,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function fetchJson(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res || !res.ok) {
    throw new Error(`IDPH fetch failed (${res ? res.status : 'no response'}): ${url}`);
  }
  return res.json();
}

// rowsUpdatedAt from the views metadata: an epoch-seconds stamp.
// Returns an ISO string (comparable across runs, storable in the
// event details and on each row as source_updated_at).
async function fetchSourceUpdatedAt(fetchImpl) {
  const meta = await fetchJson(fetchImpl, METADATA_URL);
  if (!meta || typeof meta.rowsUpdatedAt !== 'number') {
    throw new Error('IDPH metadata did not carry rowsUpdatedAt');
  }
  return new Date(meta.rowsUpdatedAt * 1000).toISOString();
}

async function fetchAllRows(fetchImpl) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = `${RESOURCE_URL}?$limit=${PAGE_SIZE}&$offset=${offset}`;
    const page = await fetchJson(fetchImpl, url);
    if (!Array.isArray(page)) {
      throw new Error('IDPH resource endpoint did not return an array');
    }
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

// The DBA embedded in a published facility name, if any:
// "Legal Name - DBA Trade Name" → "Trade Name".
function parseDba(name) {
  if (typeof name !== 'string') return null;
  const m = name.match(/^(.*?)\s+-\s+DBA\s+(.+)$/i);
  return m ? m[2].trim() : null;
}

// One Socrata row → agencies columns. facility_name may embed a
// trade name as "Legal Name - DBA Trade Name": name keeps the
// full published name (it is what IDPH searchers see), and the
// DBA part is ALSO copied to dba when present. The source has no
// state column (every record is Illinois), no contact email, and
// no separate DBA field — see the research note. Local fields
// (is_primary, notes, short_name) are not part of the mapping
// and never appear in the upsert, so a sync can't clobber them.
function mapRow(r) {
  const license = typeof r.license_number === 'string' ? r.license_number.trim() : '';
  if (!license) return null;
  const name = typeof r.facility_name === 'string' ? r.facility_name.trim() : '';
  if (!name) return null;
  const dbaMatch = name.match(/^(.*?)\s+-\s+DBA\s+(.+)$/i);
  const expRaw = typeof r.exp_date === 'string' ? r.exp_date.slice(0, 10) : null;
  return {
    license_number: license,
    name,
    dba: dbaMatch ? dbaMatch[2].trim() : null,
    street: r.address?.trim() || null,
    city: r.city?.trim() || null,
    state: 'IL',
    postal_code: r.zip?.trim() || null,
    county: r.county?.trim() || null,
    phone: r.phone?.trim() || null,
    admin_contact_name: r.contact_name?.trim() || null,
    license_expiration_date:
      expRaw && /^\d{4}-\d{2}-\d{2}$/.test(expRaw) ? expRaw : null,
  };
}

// The source stamp of the most recent NON-skipped sync, read from
// event_log (agency_sync is the system of record for sync state —
// no separate state table).
async function lastSyncedSourceUpdatedAt(db) {
  const r = await db.query(
    `SELECT details->>'source_updated_at' AS stamp
       FROM event_log
      WHERE event = 'agency_sync'
        AND COALESCE((details->>'skipped_no_change')::int, 0) = 0
        AND details->>'source_updated_at' IS NOT NULL
      ORDER BY seq DESC
      LIMIT 1`,
  );
  return r.rows.length ? r.rows[0].stamp : null;
}

const UPSERT_SQL = `
  INSERT INTO agencies (
    license_number, name, dba, street, city, state, postal_code,
    county, phone, admin_contact_name, license_expiration_date,
    source, source_updated_at, last_synced_at, active
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), true)
  ON CONFLICT (license_number) DO UPDATE SET
    name = EXCLUDED.name,
    dba = EXCLUDED.dba,
    street = EXCLUDED.street,
    city = EXCLUDED.city,
    state = EXCLUDED.state,
    postal_code = EXCLUDED.postal_code,
    county = EXCLUDED.county,
    phone = EXCLUDED.phone,
    admin_contact_name = EXCLUDED.admin_contact_name,
    license_expiration_date = EXCLUDED.license_expiration_date,
    source = EXCLUDED.source,
    source_updated_at = EXCLUDED.source_updated_at,
    last_synced_at = now(),
    active = true
  RETURNING (xmax = 0) AS inserted`;

async function syncAgencies(db, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const actor = opts.actor || { uid: 'system', email: 'agency-sync@system.local' };
  const trigger = opts.trigger || 'cli';

  let sourceUpdatedAt = null;
  let rawRows = opts.sampleRows || null;

  if (rawRows) {
    sourceUpdatedAt = opts.sampleSourceUpdatedAt || null;
  } else {
    sourceUpdatedAt = await fetchSourceUpdatedAt(fetchImpl);
  }

  // --- IDPH pass (produces the base summary; the single
  // agency_sync event is written AFTER the CMS pass so its
  // details carry both passes' counts).
  let summary = null;
  const previousStamp = await lastSyncedSourceUpdatedAt(db);
  if (sourceUpdatedAt && previousStamp && previousStamp === sourceUpdatedAt) {
    summary = {
      fetched: 0, inserted: 0, updated: 0, deactivated: 0,
      skipped_no_change: 1, source_updated_at: sourceUpdatedAt, trigger,
    };
  } else {
    if (!rawRows) {
      rawRows = await fetchAllRows(fetchImpl);
    }
    const mapped = rawRows.map(mapRow).filter(Boolean);
    if (mapped.length === 0) {
      // An empty/garbled upstream snapshot must never deactivate the
      // whole directory — fail the run instead.
      throw new Error('IDPH sync aborted: upstream returned no usable rows');
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      let inserted = 0;
      let updated = 0;
      for (const row of mapped) {
        const r = await client.query(UPSERT_SQL, [
          row.license_number, row.name, row.dba, row.street, row.city,
          row.state, row.postal_code, row.county, row.phone,
          row.admin_contact_name, row.license_expiration_date,
          SOURCE, sourceUpdatedAt,
        ]);
        if (r.rows[0].inserted) inserted += 1; else updated += 1;
      }
      const seen = mapped.map((r) => r.license_number);
      const deact = await client.query(
        `UPDATE agencies SET active = false
          WHERE source = $1 AND active = true
            AND license_number <> ALL($2::text[])`,
        [SOURCE, seen],
      );
      summary = {
        fetched: mapped.length, inserted, updated,
        deactivated: deact.rowCount, skipped_no_change: 0,
        source_updated_at: sourceUpdatedAt, trigger,
      };
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // --- CMS enrichment pass. Runs on EVERY sync (including an
  // IDPH skip — CMS republishes on its own cadence and the pass
  // is one paged query). Failure isolation: a CMS fetch failure
  // or an empty Illinois set aborts ONLY this pass — the IDPH
  // results stand — and the failure is recorded in the event
  // details as cms_error. There is deliberately no CMS-side
  // unchanged check: the matcher is idempotent (same matches →
  // same values), so re-running costs one fetch and no churn.
  summary.cms_rows = 0;
  summary.cms_matched = 0;
  summary.cms_unmatched = 0;
  try {
    const rawCmsRows = opts.sampleCmsRows || (await fetchCmsIlRows(fetchImpl));
    if (!Array.isArray(rawCmsRows) || rawCmsRows.length === 0) {
      throw new Error('CMS enrichment aborted: no Illinois rows returned');
    }
    Object.assign(summary, await runCmsEnrichment(db, rawCmsRows));
  } catch (err) {
    summary.cms_error = String((err && err.message) || err).slice(0, 200);
  }

  await insertEvent(db, {
    actor, event: 'agency_sync', details: summary,
  });
  return summary;
}

module.exports = {
  DATASET_ID,
  RESOURCE_URL,
  METADATA_URL,
  parseDba,
  mapRow,
  fetchSourceUpdatedAt,
  fetchAllRows,
  lastSyncedSourceUpdatedAt,
  CMS_DATASET_ID,
  CMS_QUERY_URL,
  fetchCmsIlRows,
  cmsMapRow,
  normalizeAgencyName,
  matchCmsRows,
  runCmsEnrichment,
  syncAgencies,
};
