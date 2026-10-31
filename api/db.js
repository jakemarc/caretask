// Postgres pool for the CareTask demo patient database. Configuration
// comes from environment only — never hardcode credentials here. On the
// VM, set:
//   PGHOST=localhost PGPORT=5432 PGDATABASE=caretask_demo
//   PGUSER=caretask_app PGPASSWORD=<the caretask_app password>
// The `pg` driver also reads these PG* variables by default, so setting
// them in the environment is enough; the explicit config below just
// documents the expected values.
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'caretask_demo',
  user: process.env.PGUSER || 'caretask_app',
  // Password comes from PGPASSWORD in the environment only. No password
  // literal lives in this file. If PGPASSWORD is unset, pg connects
  // without one (trust auth) or fails, depending on the server's config.
  ...(process.env.PGPASSWORD ? { password: process.env.PGPASSWORD } : {}),
});

module.exports = pool;
