// Photo intake parsing (2026-11-02) — turns OCR text from a
// referral sheet / intake form photo into a ContactCandidate the
// Add Patient form already knows how to apply. Pure text → data:
// the heuristics are deliberately conservative anchors first
// (labeled fields), pattern scans second, and everything lands in
// the form for human review before anything saves. OCR text is
// messy — this never pretends otherwise.
import type { ContactCandidate } from "./googleContacts";

export interface ExtractedIntake {
  candidate: ContactCandidate;
  referrer: string;
  found: string[];
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
function parseName(value: string): { fname: string; mname: string; lname: string } | null {
  const v = value.replace(/\s+/g, " ").trim();
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

export function parseIntakeText(raw: string): ExtractedIntake {
  const c = blankCandidate();
  const found: string[] = [];
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
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

  // Phones (line-labeled first, then positional).
  const phones: { value: string; kind: "cell" | "home" | "any" }[] = [];
  for (const line of lines) {
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
