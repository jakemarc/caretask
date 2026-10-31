// Google Contacts CSV import for the CareTask dashboard
// (Settings → Database utilities, built 2026-10-30).
//
// A Google Contacts export is the CSV form of Google People
// contacts — same fields the People API import (googleContacts.ts)
// maps, flattened into numbered columns ("E-mail 1 - Value",
// "Phone 2 - Label", "Address 1 - Street", …). This module parses
// the file and normalizes every row into the SAME ContactCandidate
// shape the People import produces, so both import paths share one
// mapping vocabulary. Two CSV-only extras ride alongside the
// candidate: the honorific title / suffix (Name Prefix / Name
// Suffix — ContactCandidate has no slot for them, but the patients
// and users tables do) and the three-way phone split (cell / home /
// main), because the users table stores a main phone separately
// from the home phone while the candidate merges them.
//
// Privacy shape, same as the People import: parsing happens IN THE
// BROWSER ONLY. The raw file is never uploaded anywhere; the caller
// (components/CsvImport.tsx) shows a preview and sends only the
// rows the user confirms, one by one, through the existing API
// create functions.
import type { ContactCandidate } from "./googleContacts";
import { formatUSPhone } from "./phone";
import { US_STATES } from "./usStates";

// One parsed CSV row: the shared candidate plus the CSV-only
// fields described above.
export interface CsvContact {
  candidate: ContactCandidate;
  title: string; // Name Prefix (patients.title / users.title)
  suffix: string; // Name Suffix (patients.suffix / users.suffix)
  phones: {
    cell: string; // label "Mobile"
    home: string; // label "Home"
    main: string; // first other number (Work / Main / Other / unlabeled)
  };
}

// ------------------------------------------------------------------
// CSV parser. A small state machine rather than split(",") —
// Google exports quote any field containing a comma, quote, or
// newline, escape quotes by doubling them, and separate rows with
// CRLF. Handles all of that plus a leading BOM and lone-CR rows.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false; // distinguishes an empty quoted field
  const src = text.replace(/^\uFEFF/, "");
  const pushField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted && field === "") {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      if (src[i + 1] === "\n") i += 1;
      pushRow();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  // Trailing row without a final newline.
  if (field !== "" || fieldStarted || row.length > 0) pushRow();
  return rows;
}

// ------------------------------------------------------------------
// Header access. Google writes dozens of columns; we look them up
// by exact (case-insensitive, trimmed) header name, and walk the
// numbered groups (E-mail 1/2/…, Phone 1/2/…, Address 1/2/…) until
// a group comes back completely empty.

function headerIndex(headers: string[]): Map<string, number> {
  const idx = new Map<string, number>();
  headers.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (key && !idx.has(key)) idx.set(key, i);
  });
  return idx;
}

function getter(idx: Map<string, number>, cells: string[]) {
  return (header: string): string => {
    const i = idx.get(header.trim().toLowerCase());
    if (i === undefined) return "";
    return (cells[i] ?? "").trim();
  };
}

function numbered(
  get: (h: string) => string,
  base: string,
  suffix: string,
): string[] {
  const out: string[] = [];
  for (let n = 1; n <= 10; n += 1) {
    const v = get(`${base} ${n} - ${suffix}`);
    if (v) out.push(v);
  }
  return out;
}

function numberedPairs(
  get: (h: string) => string,
  base: string,
): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (let n = 1; n <= 10; n += 1) {
    const value = get(`${base} ${n} - Value`);
    if (value) out.push({ value, label: get(`${base} ${n} - Label`) });
  }
  return out;
}

// Birthday: Google writes ISO (YYYY-MM-DD), US exports also show
// MM/DD/YYYY, and a yearless birthday as --MM-DD. The yearless form
// has no year to store — DOB is required for patients and inventing
// a year would be worse than leaving it blank — so it maps to "".
export function parseGoogleBirthday(raw: string): string {
  const v = raw.trim();
  if (!v || v.startsWith("--")) return "";
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return validDate(y, m, d);
  }
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const [, m, d, y] = us;
    return validDate(y, m, d);
  }
  return "";
}

function validDate(y: string, m: string, d: string): string {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!yy || mm < 1 || mm > 12 || dd < 1 || dd > 31) return "";
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// The dashboard's stored sex values (Add/Edit Patient selects).
const SEX_VALUES = ["Female", "Male", "Intersex", "Other", "Unknown"];

export function mapGender(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!v) return "";
  return SEX_VALUES.find((s) => s.toLowerCase() === v) ?? "";
}

// CSV Region is a state NAME ("Illinois") or sometimes the code;
// the patients/users state columns store the 2-letter code.
export function mapState(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  const hit = US_STATES.find(
    (s) => s.name.toLowerCase() === v.toLowerCase(),
  );
  return hit ? hit.code : v;
}

// CSV Country is a country NAME ("United States"); the stored
// country_code wants a code. Two-letter values pass through as
// codes; unknown names map to "" so the create path's US default
// applies rather than storing a full name in a code column.
export function mapCountry(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  const lower = v.toLowerCase();
  if (
    lower === "united states" ||
    lower === "united states of america" ||
    lower === "usa" ||
    lower === "u.s.a."
  ) {
    return "US";
  }
  return "";
}

// ------------------------------------------------------------------
// Row mapping: one CSV record → CsvContact.

function rowToContact(get: (h: string) => string, rowNum: number): CsvContact {
  // Name: structured parts first; when Given AND Family are both
  // empty, split the combined "Name" the way personToCandidate
  // splits a displayName with no parts.
  let fname = get("Given Name");
  let mname = get("Middle Name") || get("Additional Name");
  let lname = get("Family Name");
  const full = get("Name");
  if (!fname && !lname && full) {
    const parts = full.trim().split(/\s+/);
    fname = parts[0] ?? "";
    if (parts.length > 2) mname = mname || parts.slice(1, -1).join(" ");
    lname = parts.length > 1 ? parts[parts.length - 1] : "";
  }
  const displayName =
    [fname, mname, lname].filter(Boolean).join(" ") || full || "(no name)";

  const email = numbered(get, "E-mail", "Value")[0] ?? "";

  // Phones: label decides the slot. Mobile → cell, Home → home,
  // anything else (Work, Main, Other, no label) → main. The shared
  // candidate merges main into the cell slot when no mobile number
  // exists, so a work-only contact still shows its number (same
  // fallback personToCandidate uses with the first phone).
  const phonePairs = numberedPairs(get, "Phone");
  const cellIdx = phonePairs.findIndex((p) =>
    p.label.toLowerCase().includes("mobile"),
  );
  const homeIdx = phonePairs.findIndex(
    (p, i) => i !== cellIdx && p.label.toLowerCase().includes("home"),
  );
  const mainIdx = phonePairs.findIndex(
    (_, i) => i !== cellIdx && i !== homeIdx,
  );
  const cellRaw = cellIdx >= 0 ? phonePairs[cellIdx].value : "";
  const homeRaw = homeIdx >= 0 ? phonePairs[homeIdx].value : "";
  const mainRaw = mainIdx >= 0 ? phonePairs[mainIdx].value : "";
  const phones = {
    cell: formatUSPhone(cellRaw),
    home: formatUSPhone(homeRaw),
    main: formatUSPhone(mainRaw),
  };

  // Address: first numbered group carrying anything. Structured
  // parts win; a Formatted-only address keeps its text in street
  // with the rest blank (splitting free text would guess wrong).
  let street = "";
  let streetLine2 = "";
  let city = "";
  let state = "";
  let postalCode = "";
  let countryCode = "";
  for (let n = 1; n <= 4; n += 1) {
    const g = (suffix: string) => get(`Address ${n} - ${suffix}`);
    const formatted = g("Formatted");
    const s = g("Street");
    const c = g("City");
    const r = g("Region");
    const z = g("Postal Code");
    const co = g("Country");
    if (!formatted && !s && !c && !r && !z) continue;
    if (s || c || r || z) {
      street = s;
      streetLine2 = g("Extended Address");
      city = c;
      state = mapState(r);
      postalCode = z;
      countryCode = mapCountry(co);
    } else {
      street = formatted;
    }
    break;
  }

  const candidate: ContactCandidate = {
    resourceName: `csv-row-${rowNum}`,
    displayName,
    fname,
    mname,
    lname,
    email,
    phoneHome: phones.home,
    phoneCell: phones.cell || phones.main,
    street,
    streetLine2,
    city,
    state,
    postalCode,
    countryCode,
    dob: parseGoogleBirthday(get("Birthday")),
    sex: mapGender(get("Gender")),
    occupation: get("Occupation"),
    organization: get("Organization 1 - Name"),
    orgTitle: get("Organization 1 - Title"),
    note: get("Notes") || get("Biography"),
  };

  return {
    candidate,
    title: get("Name Prefix"),
    suffix: get("Name Suffix"),
    phones,
  };
}

// Parse a whole Google Contacts CSV export. Throws when the file
// has no recognizable Google header row — a wrong file should fail
// loudly in the preview, not import as empty rows. Rows with no
// name AND no email carry nothing importable and are skipped.
export function parseGoogleContactsCsv(text: string): CsvContact[] {
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (table.length === 0) throw new Error("The file is empty.");
  const idx = headerIndex(table[0]);
  const known = [
    "given name",
    "family name",
    "name",
    "e-mail 1 - value",
    "phone 1 - value",
  ];
  if (!known.some((h) => idx.has(h))) {
    throw new Error(
      "That file doesn't look like a Google Contacts CSV export — no Google contact headers were found.",
    );
  }
  const out: CsvContact[] = [];
  for (let r = 1; r < table.length; r += 1) {
    const get = getter(idx, table[r]);
    const contact = rowToContact(get, r);
    const c = contact.candidate;
    if (!c.fname && !c.lname && !c.email) continue;
    out.push(contact);
  }
  return out;
}

// ------------------------------------------------------------------
// Required-field checks, shared by the preview and the tests.
// Patients: first name, last name, date of birth, and sex are ALL
// required on create (Jake, 2026-10-30). Staff: email is the
// identity, plus first and last name.

export function missingPatientFields(contact: CsvContact): string[] {
  const c = contact.candidate;
  const missing: string[] = [];
  if (!c.fname.trim()) missing.push("first name");
  if (!c.lname.trim()) missing.push("last name");
  if (!c.dob) missing.push("date of birth");
  if (!c.sex) missing.push("sex");
  return missing;
}

export function missingStaffFields(contact: CsvContact): string[] {
  const c = contact.candidate;
  const missing: string[] = [];
  if (!c.email.trim()) missing.push("email");
  if (!c.fname.trim()) missing.push("first name");
  if (!c.lname.trim()) missing.push("last name");
  return missing;
}
