// Canonical hash-chain input shared by the SQL triggers
// (schema-events.sql) and the JS verifier (lib/verifyChain.js).
// These two implementations MUST produce identical strings, or every
// row will verify as broken. The rules, in full:
//
//   For each field, in the fixed per-table order:
//     <character count of the value> ":" <the value>
//   Fields joined with "|", hashed as UTF-8 with SHA-256, hex-encoded.
//   NULL counts as the empty string (length 0).
//   JSONB fields use Postgres's jsonb text output (the ::text form).
//   That form is NOT the compact JSON JSON.stringify produces:
//   Postgres puts a space after every structural colon and comma
//   ({"after": {...}, "before": null}), while JSON.stringify emits
//   none ({"after":{...},"before":null}). The JS side therefore
//   reproduces the Postgres form with jsonbText(), which expands the
//   compact form by inserting a space after each colon/comma that
//   sits OUTSIDE a string literal (a small tokenizer, so colons and
//   commas inside string values are untouched). Key order is
//   preserved, not re-sorted: pg returns keys in the order Postgres
//   serialized them, which is the normalized (length-then-lexical)
//   order. Values in our payloads are strings, nulls, booleans,
//   integers, arrays, and objects — all of which round-trip through
//   parse-then-stringify identically. (Exotic numerics such as 1e2,
//   which jsonb normalizes on storage, do not occur in audit/event
//   payloads.)
//   Character count is Postgres length() (characters, not bytes); the
//   JS side counts Unicode code points ([...s].length), which agrees
//   with length() for all valid input (unlike String.length, which
//   counts UTF-16 code units and diverges on astral characters).
//   created_at is deliberately EXCLUDED: its text form differs between
//   SQL and JS, and it is not a business field. Chain order comes
//   from seq, never from timestamps.
//
// Field order:
//   audit_log: prev_hash, id, seq, patient_id, actor_uid, actor_email,
//     action, changed
//   event_log: prev_hash, id, seq, actor_uid, actor_email, event,
//     patient_id, details, ip
const crypto = require('crypto');

// Code-point count, matching Postgres length().
function charLen(s) {
  return [...s].length;
}

function field(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `${charLen(text)}:${text}`;
}

// Postgres jsonb text form for a parsed value. A string is returned
// unchanged (it is already serialized text, e.g. a column selected
// with ::text). Otherwise the compact JSON.stringify output is
// expanded with a space after every structural colon and comma,
// matching Postgres's jsonb output exactly.
function jsonbText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  const compact = JSON.stringify(value);
  if (compact === undefined) return '';
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of compact) {
    out += ch;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === ':' || ch === ',') {
      out += ' ';
    }
  }
  return out;
}

function canonical(fields) {
  return fields.map(field).join('|');
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Row shapes are pg rows: id/UUIDs as strings, seq as a string (int8),
// changed/details as parsed JSON objects, nullable columns as null.
function canonicalAuditRow(row) {
  return canonical([
    row.prev_hash ?? '',
    row.id,
    String(row.seq),
    row.patient_id ?? '',
    row.actor_uid,
    row.actor_email,
    row.action,
    jsonbText(row.changed),
  ]);
}

function canonicalEventRow(row) {
  return canonical([
    row.prev_hash ?? '',
    row.id,
    String(row.seq),
    row.actor_uid,
    row.actor_email,
    row.event,
    row.patient_id ?? '',
    jsonbText(row.details),
    row.ip ?? '',
  ]);
}

module.exports = {
  canonicalAuditRow,
  canonicalEventRow,
  sha256Hex,
};
