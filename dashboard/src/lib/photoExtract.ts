// Photo intake parsing (2026-11-02; v2 layout-aware pass the
// same day, at Jake's direction — "smarter on-device parsing,
// keep it free") — turns OCR output from a referral sheet /
// intake form / patient-header photo into a ContactCandidate
// the Add Patient form already knows how to apply.
//
// v1 was text-only: labeled anchors first, pattern scans second.
// It failed on two-column EMR header screens in a dangerous way:
// the AGENCY column (clean, well-read) filled the patient's
// address/phone fields. v2 uses the OCR engine's word positions
// when they are available:
//   1. Words are regrouped into rows, rows split into segments
//      at the column gutter, and segments read column by column
//      (left column top-to-bottom, then the right) instead of
//      across merged rows.
//   2. Segments under an "Agency Information" heading are
//      EXCLUDED from patient extraction — wrong data becomes no
//      data, which the reviewer notices and types by hand.
//   3. Values wrapped across lines (phone numbers, street
//      suffixes, ZIP codes) are stitched back together before
//      extraction.
// The text-only path (no word positions) keeps the v1 behavior
// plus the line stitching. Either way everything lands in the
// form for human review before anything saves — OCR text is
// messy, and this never pretends otherwise.
import type { ContactCandidate } from "./googleContacts";

export interface ExtractedIntake {
  candidate: ContactCandidate;
  referrer: string;
  found: string[];
}

/** One OCR word with its bounding box (Tesseract coordinates). */
export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrInput {
  text: string;
  words?: OcrWord[];
}

function blankCandidate(): ContactCandidate {
  return {
    resourceName: "photo",
    displayName: "",
    fname: "",
    mname: "",
    lname: "",
    email: "",
    phoneHome: "",
    phoneCell: "",
    street: "",
    streetLine2: "",
    city: "",
    state: "",
    postalCode: "",
    countryCode: "US",
    dob: "",
    sex: "",
    occupation: "",
    organization: "",
    orgTitle: "",
    note: "",
  };
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10,
  oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

// Normalize any recognized date to YYYY-MM-DD ("" when invalid).
export function normalizeDate(raw: string): string {
  const s = raw.trim();
  let y = 0, m = 0, d = 0;
  let mm = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mm) {
    y = +mm[1]; m = +mm[2]; d = +mm[3];
  } else if ((mm = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) {
    m = +mm[1]; d = +mm[2]; y = +mm[3];
  } else if (
    (mm = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))
  ) {
    m = MONTHS[mm[1].toLowerCase()] ?? 0;
    d = +mm[2]; y = +mm[3];
  }
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return "";
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  )
    return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

const DATE_RE =
  /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{1,2}-\d{1,2}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/gi;

const PHONE_RE =
  /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;

function cleanNameToken(t: string): string {
  return t.replace(/^[^A-Za-zÀ-ÿ'-]+|[^A-Za-zÀ-ÿ'-]+$/g, "");
}

// "LAST, FIRST M" or "FIRST M LAST" → parts. Conservative: 2–4
// alphabetic tokens, otherwise "" (the reviewer types it).
// A quoted nickname (Claus, Patsy J "Pat") is decoration — it is
// stripped first, closed or dangling, or the token count rejects
// a perfectly good name.
function parseName(value: string): { fname: string; mname: string; lname: string } | null {
  const v = value
    .replace(/"[^"]*"/g, " ")
    .replace(/"[^"]*$/, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!v) return null;
  if (v.includes(",")) {
    const [last, rest] = v.split(",", 2).map((x) => x.trim());
    const firsts = (rest ?? "").split(" ").map(cleanNameToken).filter(Boolean);
    const lastT = cleanNameToken(last);
    if (lastT && firsts.length >= 1 && firsts.length <= 2) {
      return { lname: lastT, fname: firsts[0], mname: firsts[1] ?? "" };
    }
    return null;
  }
  const toks = v.split(" ").map(cleanNameToken).filter(Boolean);
  if (toks.length < 2 || toks.length > 4) return null;
  if (toks.some((t) => !/^[A-Za-zÀ-ÿ'-]+$/.test(t))) return null;
  return {
    fname: toks[0],
    mname: toks.length === 3 ? toks[1] : "",
    lname: toks[toks.length - 1],
  };
}

const HEADER_WORDS =
  /\b(health|hospital|clinic|medical|referral|intake|center|centre|care|form|patient information|home health|agency|services|therapy|physical|occupation|speech|nursing|fax|phone|address|page)\b/i;

// ----------------------------------------------------------------
// Line stitching: values that wrap across lines are rejoined
// before extraction. Conservative — each join needs an
// unambiguous shape on both sides of the break.
// ----------------------------------------------------------------

const STREET_SUFFIX_START =
  /^(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Ct|Court|Way|Cir|Circle|Hwy|Highway|Pl|Place|Ter|Terrace)\b\.?/i;

export function unwrapLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const prev = out[out.length - 1];
    if (prev) {
      // Phone split mid-number: "Mobile: 708-" + "334-6607",
      // "Home: 708-946-" + "6607", "708 946" + "6607".
      const prevPhoneish =
        /(?:phone|cell|mobile|home|work|tel|fax)\b/i.test(prev) ||
        /\d{3}[-.\s]\d{3}$/.test(prev) ||
        /\d{3}[-.\s]$/.test(prev);
      if (
        prevPhoneish &&
        /\d{3}[-.\s]$/.test(prev) &&
        /^\d{3}[-.\s]\d{4}\b/.test(line)
      ) {
        out[out.length - 1] = prev + line;
        continue;
      }
      if (
        prevPhoneish &&
        /\d{3}[-.\s]?$/.test(prev) &&
        /^\d{4}\b/.test(line) &&
        !/\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/.test(prev)
      ) {
        out[out.length - 1] = prev + (prev.endsWith(" ") ? "" : " ") + line;
        continue;
      }
      // Street split before its suffix: "625 MELROSE" + "LN".
      if (
        /\d{1,6}\s+[A-Za-z][A-Za-z .'#-]*$/.test(prev) &&
        !STREET_SUFFIX_START.test(prev.split(" ").pop() ?? "") &&
        STREET_SUFFIX_START.test(line)
      ) {
        out[out.length - 1] = prev + " " + line;
        continue;
      }
      // City/state split from its ZIP: "BEECHER, IL" + "60401".
      if (/[A-Za-z .'-]+,\s*[A-Z]{2}$/.test(prev) && /^\d{5}(?:-\d{4})?\b/.test(line)) {
        out[out.length - 1] = prev + " " + line;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

// ----------------------------------------------------------------
// Layout pass (v2): word positions → ordered, section-filtered
// lines. Segments under an agency heading are dropped entirely.
// ----------------------------------------------------------------

interface Segment {
  text: string;
  col: number;
  y: number;
}

function segmentsFromWords(words: OcrWord[]): Segment[] {
  const clean = words.filter((w) => w.text.trim());
  if (clean.length === 0) return [];
  const pageWidth = Math.max(...clean.map((w) => w.x1));
  const heights = clean.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 12;
  const rowTol = Math.max(6, medH * 0.7);

  // Group words into visual rows by vertical proximity.
  const byY = [...clean].sort(
    (a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0,
  );
  const rows: { yc: number; words: OcrWord[] }[] = [];
  for (const w of byY) {
    const yc = (w.y0 + w.y1) / 2;
    const row = rows[rows.length - 1];
    if (row && Math.abs(yc - row.yc) <= rowTol) {
      row.words.push(w);
      row.yc = (row.yc * (row.words.length - 1) + yc) / row.words.length;
    } else {
      rows.push({ yc, words: [w] });
    }
  }

  // Find the column gutter: the widest word-free vertical band
  // in the middle 60% of the page, at least 3.5% of width.
  const BINS = 100;
  const covered = new Array<boolean>(BINS).fill(false);
  for (const w of clean) {
    const mid = ((w.x0 + w.x1) / 2 / pageWidth) * BINS;
    covered[Math.min(BINS - 1, Math.max(0, Math.floor(mid)))] = true;
  }
  let gutter = -1;
  let bestRun = 0;
  let runStart = -1;
  for (let i = 20; i < 80; i++) {
    if (!covered[i]) {
      if (runStart < 0) runStart = i;
      const run = i - runStart + 1;
      if (run > bestRun) {
        bestRun = run;
        gutter = runStart + run / 2;
      }
    } else {
      runStart = -1;
    }
  }
  const gutterX = bestRun >= 3.5 ? (gutter / BINS) * pageWidth : -1;

  // Split each row into segments at wide horizontal gaps, tag
  // each segment with its column, and order column-major.
  const gapMin = pageWidth * 0.05;
  const segs: Segment[] = [];
  for (const row of rows) {
    const ws = [...row.words].sort((a, b) => a.x0 - b.x0);
    let cur: OcrWord[] = [];
    const flush = () => {
      if (cur.length === 0) return;
      const x0 = Math.min(...cur.map((w) => w.x0));
      const x1 = Math.max(...cur.map((w) => w.x1));
      segs.push({
        text: cur.map((w) => w.text).join(" "),
        col: gutterX >= 0 && (x0 + x1) / 2 >= gutterX ? 1 : 0,
        y: row.yc,
      });
      cur = [];
    };
    for (const w of ws) {
      const prevW = cur[cur.length - 1];
      if (prevW && w.x0 - prevW.x1 > gapMin) flush();
      cur.push(w);
    }
    flush();
  }
  return segs.sort((a, b) => a.col - b.col || a.y - b.y);
}

const AGENCY_HEADING =
  /\bagency\s+(?:information|info|details)\b|\bhome\s+care\s+agency\b/i;
const PATIENT_HEADING =
  /\bhome\s+care\s+address\b|\bpatient\s+(?:address|information)\b|\bdirections\b/i;

function patientLinesFromWords(words: OcrWord[]): string[] {
  const segs = segmentsFromWords(words);
  const lines: string[] = [];
  let section: "patient" | "agency" = "patient";
  for (const s of segs) {
    if (AGENCY_HEADING.test(s.text)) {
      section = "agency";
      continue;
    }
    if (PATIENT_HEADING.test(s.text)) section = "patient";
    if (section === "agency") continue;
    lines.push(s.text);
  }
  return lines;
}

// ----------------------------------------------------------------
// Field extraction over an ordered line list (the v1 logic).
// ----------------------------------------------------------------

function extractFromLines(inputLines: string[]): ExtractedIntake {
  const c = blankCandidate();
  const found: string[] = [];
  const lines = inputLines.map((l) => l.trim()).filter(Boolean);
  const text = lines.join("\n");
  const labeled = (re: RegExp): string | null => {
    for (const line of lines) {
      const m = line.match(re);
      if (m) return (m[1] ?? "").trim();
    }
    return null;
  };

  // Email.
  const email = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  if (email) {
    c.email = email[0].toLowerCase();
    found.push("Email");
  }

  // Phones (line-labeled first, then positional). A number on a
  // Fax line is never a phone — fax numbers used to land in the
  // home slot when a labeled number was wrapped and missed.
  const phones: { value: string; kind: "cell" | "home" | "any" }[] = [];
  for (const line of lines) {
    if (/\bfax\b/i.test(line)) continue;
    const nums = line.match(PHONE_RE) ?? [];
    for (const n of nums) {
      const kind = /\b(cell|mobile|cellular)\b/i.test(line)
        ? "cell"
        : /\b(home|residence)\b/i.test(line)
          ? "home"
          : "any";
      phones.push({ value: n.trim(), kind });
    }
  }
  const cell = phones.find((p) => p.kind === "cell");
  const home = phones.find((p) => p.kind === "home");
  const rest = phones.filter((p) => p !== cell && p !== home);
  if (cell) c.phoneCell = cell.value;
  if (home) c.phoneHome = home.value;
  for (const p of rest) {
    if (!c.phoneCell) c.phoneCell = p.value;
    else if (!c.phoneHome) c.phoneHome = p.value;
  }
  PHONE_RE.lastIndex = 0;
  if (c.phoneCell || c.phoneHome) found.push("Phone");

  // Date of birth (labeled first; else the first plausibly-old
  // date — referral/visit dates are recent, births are not).
  let dob =
    labeled(/(?:DOB|Date of Birth|Birth\s*Date|Born)\s*[:#]?\s*(.+)/i) ?? "";
  let dobIso = dob ? normalizeDate(dob.match(DATE_RE)?.[0] ?? "") : "";
  if (!dobIso) {
    const all = [...text.matchAll(DATE_RE)].map((m) => m[0]);
    const cutoff = new Date().getFullYear() - 25;
    for (const candidate of all) {
      const iso = normalizeDate(candidate);
      if (iso && Number(iso.slice(0, 4)) <= cutoff) {
        dobIso = iso;
        break;
      }
    }
  }
  if (dobIso) {
    c.dob = dobIso;
    found.push("Date of birth");
  }

  // Sex (label first, then the standalone words).
  const sexLabel = labeled(
    /(?:Sex|Gender)\s*[:#]?\s*(Female|Male|F|M)\b/i,
  );
  const sexWord = sexLabel ?? text.match(/\b(Female|Male)\b/i)?.[1] ?? "";
  if (/^f/i.test(sexWord)) c.sex = "Female";
  else if (/^m/i.test(sexWord)) c.sex = "Male";
  if (c.sex) found.push("Sex");

  // Name (label first, then a conservative first-lines scan).
  let nameParts: ReturnType<typeof parseName> = null;
  const nameLabel = labeled(
    /(?:Patient(?:'s)?\s+Name|Full\s+Name|Name)\s*[:#]?\s*(.+)/i,
  );
  if (nameLabel) nameParts = parseName(nameLabel);
  if (!nameParts) {
    for (const line of lines.slice(0, 6)) {
      if (HEADER_WORDS.test(line) || /[:@\d]/.test(line)) continue;
      // Screen photos carry UI chrome (toolbar buttons like
      // "Sync Patient / Remove Patient") whose words parse as a
      // plausible name — symbols and UI verbs give them away.
      if (/[%©§]/.test(line)) continue;
      if (
        /\b(sync|remove|update|alerts?|screening|comments?|directions)\b/i.test(
          line,
        ) &&
        !line.includes(",")
      )
        continue;
      nameParts = parseName(line);
      if (nameParts) break;
    }
  }
  if (nameParts) {
    c.fname = nameParts.fname;
    c.mname = nameParts.mname;
    c.lname = nameParts.lname;
    c.displayName = [c.fname, c.mname, c.lname].filter(Boolean).join(" ");
    found.push("Name");
  }

  // Address (labeled line first, then a street-suffix scan; then
  // city/state/ZIP from the same or following lines).
  const streetRe =
    /\d{1,6}\s+[A-Za-z0-9 .'#-]+?\b(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Ct|Court|Way|Cir|Circle|Hwy|Highway|Pl|Place|Ter|Terrace)\b\.?/i;
  let street =
    labeled(/(?:Address|Street)\s*[:#]?\s*(.+)/i) ?? "";
  if (!streetRe.test(street)) {
    street = lines.find((l) => streetRe.test(l)) ?? "";
  }
  const streetMatch = street.match(streetRe);
  if (streetMatch) {
    c.street = streetMatch[0].trim();
    found.push("Address");
  }
  const csz = text.match(
    /([A-Za-z][A-Za-z .'-]{1,30}),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/,
  );
  if (csz) {
    c.city = csz[1].trim().replace(/,$/, "");
    c.state = csz[2];
    c.postalCode = csz[3];
    if (!found.includes("Address")) found.push("Address");
  }

  // Referrer (ordering/referring clinician).
  const referrer =
    labeled(
      /(?:Referring(?:\s+(?:Physician|Provider|Doctor))?|Referred\s+by|Ordering(?:\s+(?:Physician|Provider))?|Ref\.?\s*(?:Physician|Provider|Doctor))\s*[:#]?\s*(.+)/i,
    ) ?? "";
  const cleanRef = referrer.replace(/\s{2,}.*$/, "").trim();

  return { candidate: c, referrer: cleanRef, found };
}

/** Text-only entry point (v1 behavior + line stitching). */
export function parseIntakeText(raw: string): ExtractedIntake {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return extractFromLines(unwrapLines(lines));
}

/**
 * Layout-aware entry point: when the OCR result carries word
 * positions, fields are extracted from the patient sections
 * only (agency blocks excluded), read column by column, with
 * wrapped values stitched. Without positions it falls back to
 * the text path.
 */
export function parseIntakeOcr(input: OcrInput): ExtractedIntake {
  if (input.words && input.words.length > 0) {
    const lines = patientLinesFromWords(input.words);
    if (lines.length > 0) return extractFromLines(unwrapLines(lines));
  }
  return parseIntakeText(input.text);
}
