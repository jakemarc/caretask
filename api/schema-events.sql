-- CareTask demo audit core — central event log + tamper-evident hash chains.
--
-- DEMO DATA ONLY, same rule as schema.sql: every row here is meant to be
-- fictional. No real patient data goes in these tables until TLS, a
-- signed BAA, and the company entity are all in place.
--
-- Apply AFTER schema.sql, connected to the caretask_demo database:
--   psql -h localhost -U caretask_app -d caretask_demo -f schema.sql
--   psql -h localhost -U caretask_app -d caretask_demo -f schema-events.sql
-- (Use whichever role created the tables if caretask_app lacks ALTER.)
--
-- What this adds, and why it is shaped this way:
--
-- 1. event_log — the central event stream (OpenEMR's `log` equivalent).
--    audit_log stays exactly what it was: the per-patient mutation trail
--    with before/after snapshots. event_log records everything else a
--    reviewer needs: patient views (reads, which audit_log never saw),
--    sign-ins and sign-outs (reported by the dashboard, since Firebase
--    owns the actual login), report exports, auth failures, admin
--    actions, and one api_request row per API call (method, path,
--    status — never tokens, passwords, or request bodies).
--    patient_id is deliberately NOT a foreign key: events are historical
--    records that must survive patient-table resets (the seed script
--    truncates patients), so the id is informational, not a constraint.
--
-- 2. Hash chains — tamper evidence for audit_log AND event_log
--    (OpenEMR's log_comment_encrypt idea, taken one step further).
--    Every row carries prev_hash (the previous row's hash, NULL for the
--    first chained row) and row_hash (SHA-256 over the canonical row
--    content plus prev_hash). Any edit, deletion, or reorder breaks the
--    chain at the next row, and the verifier reports exactly which row.
--    The chain is computed by a BEFORE INSERT trigger, so no API code
--    path can insert an unchained row, and no API endpoint can rewrite
--    a hash. Rows created before this migration have NULL hashes and
--    are reported by the verifier as "legacy (unchained)", never as
--    broken: the chain is only claimed from the first hashed row on.
--
--    Canonical hash input (MUST match lib/hashChain.js exactly):
--      for each field, in the fixed order below:
--        <character count of the value> ":" <the value>
--      fields joined with "|", hashed as UTF-8 with SHA-256, hex-encoded.
--      NULL counts as the empty string (length 0). JSONB fields use
--      Postgres's jsonb text output (::text), which puts a space
--      after every structural colon and comma — NOT the compact form
--      JSON.stringify produces. The JS verifier reproduces the
--      Postgres form by expanding the compact form (see jsonbText in
--      lib/hashChain.js), WITHOUT re-sorting keys (node-postgres
--      preserves the order Postgres serialized, which is the
--      normalized order).
--      Character count is Postgres length() (characters, not bytes);
--      the JS side counts Unicode code points ([...s].length), which
--      agrees with length() for all valid input.
--      created_at is deliberately EXCLUDED: its text form differs
--      between SQL and JS, and it is not a business field. Ordering
--      comes from seq, never from timestamps.
--      audit_log fields: prev_hash, id, seq, patient_id, actor_uid,
--        actor_email, action, changed
--      event_log fields: prev_hash, id, seq, actor_uid, actor_email,
--        event, patient_id, details, ip
--
-- 3. seq — a monotonic integer on both tables, assigned BY THE
--    TRIGGER under a per-table advisory transaction lock, as
--    MAX(seq) + 1. Timestamps can tie (same transaction, same
--    millisecond); seq never does, so chain order is unambiguous.
--    The column is declared BIGSERIAL, but the trigger OVERWRITES
--    NEW.seq: the sequence default fires before the lock is taken,
--    so two racing inserts could otherwise receive seqs in the
--    opposite order to their lock acquisition — and the chain
--    (linked by "last row at trigger time") would then disagree
--    with seq order, failing verification with a prev_hash
--    mismatch even though nothing was tampered with. (Probed
--    2026-10-29: a fire-and-forget api_request insert racing a
--    synchronous patient_view insert broke verification exactly
--    this way before this fix.) Assigning seq inside the lock makes
--    seq order always equal chain order. Sequence gaps from the
--    overwritten default are harmless.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- audit_log chain columns
-- Additive only: existing rows keep working, with NULL hashes marking
-- them as pre-chain (legacy) rows for the verifier.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS row_hash TEXT;

-- ---------------------------------------------------------------- event_log table
CREATE TABLE IF NOT EXISTS event_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         BIGSERIAL NOT NULL,
  -- Actor is always present: requests with no verified token (auth
  -- failures) use the 'anonymous' sentinel rather than NULL, so a
  -- reviewer can filter for them instead of guessing what NULL meant.
  actor_uid   TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  -- Event vocabulary. Server-generated events (patient_view,
  -- auth_failure, api_request, admin_action) are written by the API
  -- itself and are NEVER accepted from clients. Client-reportable
  -- events (sign_in, sign_out, report_export) come only through
  -- POST /events, which rejects anything else.
  event       TEXT NOT NULL
              CHECK (event IN (
                'patient_view', 'sign_in', 'sign_out', 'report_export',
                'auth_failure', 'api_request', 'admin_action'
              )),
  -- Informational only, not a foreign key (see header note): events
  -- must survive patient-table resets.
  patient_id  UUID,
  -- Structured detail. For api_request: {method, path, status}.
  -- Never tokens, passwords, or request bodies.
  details     JSONB NOT NULL DEFAULT '{}',
  -- Remote address as seen by the API (behind Caddy this is localhost;
  -- the proxy address, not the clinician's, unless forwarding is set).
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash   TEXT,
  row_hash    TEXT
);

-- Newest-first reads, and the filtered reads the dashboard viewer uses.
CREATE INDEX IF NOT EXISTS event_log_created_idx
  ON event_log (created_at DESC);
CREATE INDEX IF NOT EXISTS event_log_actor_idx
  ON event_log (actor_email, created_at DESC);
CREATE INDEX IF NOT EXISTS event_log_event_idx
  ON event_log (event, created_at DESC);
CREATE INDEX IF NOT EXISTS event_log_patient_idx
  ON event_log (patient_id, created_at DESC);

-- ---------------------------------------------------------------- append-only guards
-- Mirrors audit_log_append_only: any UPDATE or DELETE raises, so the
-- only way rows appear is INSERT, and the only way rows disappear is
-- a setup-time TRUNCATE by the table owner (which the API never does).
CREATE OR REPLACE FUNCTION event_log_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'event_log is append-only: % is not allowed', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_log_no_update ON event_log;
CREATE TRIGGER event_log_no_update
  BEFORE UPDATE ON event_log
  FOR EACH ROW EXECUTE FUNCTION event_log_append_only();

DROP TRIGGER IF EXISTS event_log_no_delete ON event_log;
CREATE TRIGGER event_log_no_delete
  BEFORE DELETE ON event_log
  FOR EACH ROW EXECUTE FUNCTION event_log_append_only();

-- ---------------------------------------------------------------- hash-chain triggers
-- Canonical string: length-prefixed fields joined with "|", hashed
-- with SHA-256. Field order and empty-for-NULL rules MUST match
-- lib/hashChain.js, or verification will report every row as broken.
CREATE OR REPLACE FUNCTION audit_log_chain()
RETURNS TRIGGER AS $$
DECLARE
  prev TEXT;
  canon TEXT;
BEGIN
  -- Serialize chain appends: without this, two concurrent inserts
  -- could both read the same previous hash.
  PERFORM pg_advisory_xact_lock(727001);
  -- Assign seq inside the lock (see header note 3): this overwrites
  -- the BIGSERIAL default so seq order always equals chain order.
  NEW.seq := (SELECT COALESCE(MAX(seq), 0) + 1 FROM audit_log);
  SELECT row_hash INTO prev FROM audit_log ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := prev;
  canon :=
    length(COALESCE(prev, '')) || ':' || COALESCE(prev, '') || '|' ||
    length(NEW.id::text) || ':' || NEW.id::text || '|' ||
    length(NEW.seq::text) || ':' || NEW.seq::text || '|' ||
    length(NEW.patient_id::text) || ':' || NEW.patient_id::text || '|' ||
    length(NEW.actor_uid) || ':' || NEW.actor_uid || '|' ||
    length(NEW.actor_email) || ':' || NEW.actor_email || '|' ||
    length(NEW.action) || ':' || NEW.action || '|' ||
    length(NEW.changed::text) || ':' || NEW.changed::text;
  -- convert_to, NOT a ::bytea cast: casting text to bytea parses the
  -- string as a bytea literal (where a backslash must start an octal
  -- escape), so JSON text containing \" would fail. convert_to
  -- UTF-8-encodes the string, matching the JS side's Buffer encoding.
  NEW.row_hash := encode(sha256(convert_to(canon, 'UTF8')), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_chain_trigger ON audit_log;
CREATE TRIGGER audit_log_chain_trigger
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE OR REPLACE FUNCTION event_log_chain()
RETURNS TRIGGER AS $$
DECLARE
  prev TEXT;
  canon TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(727002);
  -- Assign seq inside the lock (see audit_log_chain + header note 3).
  NEW.seq := (SELECT COALESCE(MAX(seq), 0) + 1 FROM event_log);
  SELECT row_hash INTO prev FROM event_log ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := prev;
  canon :=
    length(COALESCE(prev, '')) || ':' || COALESCE(prev, '') || '|' ||
    length(NEW.id::text) || ':' || NEW.id::text || '|' ||
    length(NEW.seq::text) || ':' || NEW.seq::text || '|' ||
    length(NEW.actor_uid) || ':' || NEW.actor_uid || '|' ||
    length(NEW.actor_email) || ':' || NEW.actor_email || '|' ||
    length(NEW.event) || ':' || NEW.event || '|' ||
    length(COALESCE(NEW.patient_id::text, '')) || ':' || COALESCE(NEW.patient_id::text, '') || '|' ||
    length(NEW.details::text) || ':' || NEW.details::text || '|' ||
    length(COALESCE(NEW.ip, '')) || ':' || COALESCE(NEW.ip, '');
  -- convert_to, NOT a ::bytea cast (see audit_log_chain above).
  NEW.row_hash := encode(sha256(convert_to(canon, 'UTF8')), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_log_chain_trigger ON event_log;
CREATE TRIGGER event_log_chain_trigger
  BEFORE INSERT ON event_log
  FOR EACH ROW EXECUTE FUNCTION event_log_chain();
