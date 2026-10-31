// Operator tool: verify the audit_log + event_log hash chains directly
// against Postgres — no HTTP, no Firebase token needed. Uses the same
// PG* environment variables as db.js (PGHOST, PGPORT, PGDATABASE,
// PGUSER, PGPASSWORD).
//
// Usage: node scripts/verify-chain.js
// Exit 0 when every chain is valid, 1 when any chain is broken.
// Legacy rows (NULL row_hash, created before the chain migration) are
// reported, not treated as breaks.
//
// DEMO DATA ONLY: this script only reads. It never inserts, updates,
// or deletes.
const pool = require('../db');
const { verifyAll } = require('../lib/verifyChain');

async function main() {
  const result = await verifyAll(pool);
  for (const [table, report] of Object.entries(result)) {
    console.log(
      `${table}: ${report.total} rows, ${report.legacy} legacy, ` +
        `${report.checked} checked, valid=${report.valid}`,
    );
    if (report.first_break) {
      console.log(
        `  FIRST BREAK at seq ${report.first_break.seq} ` +
          `(id ${report.first_break.id}): ${report.first_break.reason}`,
      );
    }
  }
  await pool.end();
  const allValid = Object.values(result).every((r) => r.valid);
  process.exit(allValid ? 0 : 1);
}

main().catch(async (err) => {
  console.error('verify-chain failed:', err.message);
  try {
    await pool.end();
  } catch {
    // Pool already closed or never opened.
  }
  process.exit(1);
});
