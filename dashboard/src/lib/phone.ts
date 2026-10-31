// US phone display format: (312) 555-0142.
//
// formatUSPhone formats progressively while typing — it works on
// the digits only, tolerates a leading country-code 1, caps at 10
// digits, and never forces a half-typed number into a shape the
// user can't backspace out of. Non-US / already-odd values with
// more than 11 digits are returned unchanged rather than mangled.
// Tap-to-call href (Jake, 2026-10-30 — site-wide: every phone
// number the dashboard displays is a tel: link). tel: opens the
// device's own phone app with the number ready to call. US
// numbers are normalized to +1XXXXXXXXXX; anything else dials
// as-is. Returns null when there is nothing dialable, so callers
// can fall back to plain text.
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1"))
    return `tel:+${digits}`;
  return `tel:${digits}`;
}

export function formatUSPhone(raw: string): string {
  if (!raw) return "";
  let digits = raw.replace(/\D/g, "");
  if (digits.length > 11) return raw;
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  if (digits.length <= 3) return digits ? `(${digits}` : "";
  if (digits.length <= 6)
    return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}
