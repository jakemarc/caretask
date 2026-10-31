// Hash-chain verification for audit_log and event_log.
//
// Walk each table in seq order and recompute every row's hash from its
// stored fields (see lib/hashChain.js for the canonical form). A row
// verifies when its prev_hash equals the previous verified row's
// row_hash AND its stored row_hash equals the recomputed hash.
//
// Rows with a NULL row_hash predate chaining (created before the
// schema-events.sql migration). They are reported as `legacy` and
// skipped, never counted as broken: the chain is only claimed from
// the first hashed row onward. A break stops the walk for that table
// at the first bad row, which the report names by seq and id, so a
// reviewer can see exactly where the trail stops trusting.
//
// verifyTable(client, table) also accepts a table created as a copy
// (CREATE TABLE ... AS SELECT *), which is how the tamper tests prove
// detection without touching the real tables: the copy has the same
// columns but no triggers, so test rows can be altered in it.
const { canonicalAuditRow, canonicalEventRow, sha256Hex } = require('./hashChain');

const SPECS = {
  audit_log: {
    columns: 'id, seq, prev_hash, row_hash, patient_id, actor_uid, actor_email, action, changed',
    canonical: canonicalAuditRow,
  },
  event_log: {
    columns: 'id, seq, prev_hash, row_hash, actor_uid, actor_email, event, patient_id, details, ip',
    canonical: canonicalEventRow,
  },
};

async function verifyTable(client, table, specName = table) {
  const spec = SPECS[specName];
  if (!spec) throw new Error(`no chain spec for table ${specName}`);
  const { rows } = await client.query(
    `SELECT ${spec.columns} FROM ${table} ORDER BY seq ASC`,
  );
  let expectedPrev = null;
  let checked = 0;
  let legacy = 0;
  let firstBreak = null;
  for (const row of rows) {
    if (row.row_hash === null || row.row_hash === undefined) {
      legacy += 1;
      continue;
    }
    if (row.prev_hash !== expectedPrev) {
      firstBreak = {
        seq: String(row.seq),
        id: row.id,
        reason: 'prev_hash mismatch',
        expected_prev_hash: expectedPrev,
        actual_prev_hash: row.prev_hash,
      };
      break;
    }
    const recomputed = sha256Hex(spec.canonical(row));
    if (recomputed !== row.row_hash) {
      firstBreak = {
        seq: String(row.seq),
        id: row.id,
        reason: 'row_hash mismatch',
        expected_row_hash: recomputed,
        actual_row_hash: row.row_hash,
      };
      break;
    }
    checked += 1;
    expectedPrev = row.row_hash;
  }
  return {
    table,
    total: rows.length,
    legacy,
    checked,
    valid: firstBreak === null,
    first_break: firstBreak,
  };
}

async function verifyAll(client) {
  return {
    audit_log: await verifyTable(client, 'audit_log'),
    event_log: await verifyTable(client, 'event_log'),
  };
}

module.exports = { verifyTable, verifyAll };
