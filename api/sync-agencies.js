// CLI wrapper for the IDPH agency directory sync (lib/agencySync.js).
//
// Usage:
//   node sync-agencies.js [--live]
//       Fetch the live IDPH dataset (default) and sync it into the
//       configured database (PG* env, same contract as db.js).
//       Skips cheaply when the dataset's rowsUpdatedAt is
//       unchanged since the last successful sync.
//   node sync-agencies.js --sample <file.json>
//       Offline run from a local Socrata-shaped payload: either a
//       bare array of rows, or { "source_updated_at": "<ISO>",
//       "rows": [ ... ] }. Used by tests and for rehearsing an
//       import without touching the network.
//   --cms-sample <file.json> (with --sample)
//       Also feed the CMS enrichment pass offline: a bare array
//       of CMS datastore-shaped rows (fixtures/cms-sample.json).
//       Without it, a --sample run passes empty CMS rows, which
//       the lib records as a cms_error on the event (the IDPH
//       results still stand) rather than touching the network.
//
// The systemd timer (deploy/caretask-agency-sync.{service,timer})
// runs the --live form weekly on the VM. This script is also the
// manual "sync right now" tool: it prints the summary JSON the
// lib returns (counts only) and exits non-zero on failure. The
// lib writes the single agency_sync event_log entry — this
// wrapper never logs a second one.
const fs = require('fs');
const pool = require('./db');
const { syncAgencies } = require('./lib/agencySync');

async function main() {
  const args = process.argv.slice(2);
  const sampleIdx = args.indexOf('--sample');
  const opts = {
    actor: { uid: 'cli', email: 'sync-agencies-cli@system.local' },
    trigger: 'cli',
  };
  if (sampleIdx !== -1) {
    const file = args[sampleIdx + 1];
    if (!file) {
      console.error('usage: node sync-agencies.js --sample <file.json>');
      process.exit(2);
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) {
      opts.sampleRows = parsed;
    } else if (parsed && Array.isArray(parsed.rows)) {
      opts.sampleRows = parsed.rows;
      opts.sampleSourceUpdatedAt = parsed.source_updated_at || null;
    } else {
      console.error('sample file must be a JSON array of Socrata rows, or { source_updated_at, rows }');
      process.exit(2);
    }
    const cmsIdx = args.indexOf('--cms-sample');
    if (cmsIdx !== -1) {
      const cmsFile = args[cmsIdx + 1];
      if (!cmsFile) {
        console.error('usage: node sync-agencies.js --sample <file.json> --cms-sample <cms.json>');
        process.exit(2);
      }
      const cmsParsed = JSON.parse(fs.readFileSync(cmsFile, 'utf8'));
      if (!Array.isArray(cmsParsed)) {
        console.error('cms sample file must be a JSON array of CMS rows');
        process.exit(2);
      }
      opts.sampleCmsRows = cmsParsed;
    } else {
      // Offline determinism: no network in sample mode.
      opts.sampleCmsRows = [];
    }
  } else if (args.length && !args.includes('--live')) {
    console.error('usage: node sync-agencies.js [--live | --sample <file.json>]');
    process.exit(2);
  }
  const summary = await syncAgencies(pool, opts);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('agency sync failed:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
