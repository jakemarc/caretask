// vCard 3.0 builder for the phone contacts sync
// (carddav-contacts-sync-spec.md §5–§6). Directory fields ONLY:
// name, phones, email, address. Nothing clinical ever reaches
// this module — the caller passes a patient row and only the
// fields below are read.
const crypto = require('crypto');

// vCard text escaping: backslash, comma, semicolon, newline.
function esc(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .trim();
}

// Fold lines longer than 75 octets (CRLF + single space), per
// RFC 6350 §3.2. Folds on character boundaries without splitting
// a multi-byte UTF-8 sequence past the octet budget.
function foldLine(line) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;
  let out = '';
  let rest = line;
  let first = true;
  while (Buffer.byteLength(rest, 'utf8') > (first ? 75 : 74)) {
    let cut = 0;
    let bytes = 0;
    const limit = first ? 75 : 74;
    for (const ch of rest) {
      const b = Buffer.byteLength(ch, 'utf8');
      if (bytes + b > limit) break;
      bytes += b;
      cut += ch.length;
    }
    out += rest.slice(0, cut) + '\r\n ';
    rest = rest.slice(cut);
    first = false;
  }
  return out + rest;
}

// The canonical tuple the content hash covers — exactly the
// synced fields, so a change to anything else (notes, zone,
// DOB…) never triggers a re-sync.
function syncTuple(p) {
  return {
    fname: p.fname || '',
    mname: p.mname || '',
    lname: p.lname || '',
    phone_cell: p.phone_cell || '',
    phone_home: p.phone_home || '',
    email: p.email || '',
    street: p.street || '',
    street_line_2: p.street_line_2 || '',
    city: p.city || '',
    state: p.state || '',
    postal_code: p.postal_code || '',
    country_code: p.country_code || '',
  };
}

function contentHash(p) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(syncTuple(p)))
    .digest('hex');
}

// Build the vCard body for a patient row. `rev` is an ISO
// timestamp string for the REV property.
function buildVCard(p, rev) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//Marc Innotech//CareTask//EN'];
  lines.push(`UID:${p.id}`);
  const n = [esc(p.lname), esc(p.fname), esc(p.mname), '', ''].join(';');
  lines.push(`N:${n}`);
  const fn = [p.fname, p.mname, p.lname].filter(Boolean).join(' ').trim();
  lines.push(`FN:${esc(fn) || 'Unknown'}`);
  if (p.phone_cell) lines.push(`TEL;TYPE=CELL,VOICE:${esc(p.phone_cell)}`);
  if (p.phone_home) lines.push(`TEL;TYPE=HOME,VOICE:${esc(p.phone_home)}`);
  if (p.email) lines.push(`EMAIL;TYPE=INTERNET:${esc(p.email)}`);
  if (p.street) {
    const street = [p.street, p.street_line_2].filter(Boolean).join(', ');
    const adr = ['', '', esc(street), esc(p.city), esc(p.state), esc(p.postal_code), esc(p.country_code)].join(';');
    lines.push(`ADR;TYPE=HOME:${adr}`);
  }
  if (rev) lines.push(`REV:${rev}`);
  lines.push('END:VCARD');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = { buildVCard, contentHash, syncTuple, esc, foldLine };
