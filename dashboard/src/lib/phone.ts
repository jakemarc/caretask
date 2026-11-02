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

// ── Calling app choice (Jake, 2026-11-02) ──────────────────────
// Settings → Calling app: which app Call buttons hand the number
// to. Only apps with a real web handoff qualify (his rule):
// - phone: tel: — the device dialer, number ready.
// - googlevoice: voice.google.com opens with the number in the
//   dialer (the Voice app via universal link when installed).
// - whatsapp: wa.me opens the chat for the number (the call
//   button inside WhatsApp is one more tap; the patient needs
//   WhatsApp).
// - facetime: facetime-audio: hands the number to FaceTime
//   (Apple devices).
// Doximity Dialer is deliberately NOT offered: its prefill
// handoff exists only for native-app integrations (Epic
// Haiku/Canto, its Android library) — no web link hands it a
// number, and Dialer eligibility (MD/NP/PA/pharmacist) does not
// include PTs. The choice is remembered on this device
// (localStorage, like the theme) and never asked per tap.
export type CallingApp = "phone" | "googlevoice" | "whatsapp" | "facetime";

const CALLING_APP_KEY = "caretask-calling-app";

export function getCallingApp(): CallingApp {
  try {
    const v = localStorage.getItem(CALLING_APP_KEY);
    if (
      v === "googlevoice" ||
      v === "whatsapp" ||
      v === "facetime" ||
      v === "phone"
    )
      return v;
  } catch {
    // Private-mode storage failures just fall back to Phone.
  }
  return "phone";
}

export function setCallingApp(v: CallingApp): void {
  try {
    localStorage.setItem(CALLING_APP_KEY, v);
  } catch {
    // Non-fatal: the choice just won't persist on this device.
  }
}

// The href a Call button should use for this number, honoring
// the saved calling app. Null when the number isn't dialable.
export function callingHref(
  phone: string | null | undefined,
): string | null {
  const tel = telHref(phone);
  if (!tel) return null;
  const e164 = tel.slice("tel:".length);
  const digits = e164.replace(/\D/g, "");
  switch (getCallingApp()) {
    case "googlevoice":
      return `https://voice.google.com/calls?a=nc,%2B${digits}`;
    case "whatsapp":
      return `https://wa.me/${digits}`;
    case "facetime":
      return `facetime-audio://${e164.startsWith("+") ? e164 : `+${digits}`}`;
    default:
      return tel;
  }
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
