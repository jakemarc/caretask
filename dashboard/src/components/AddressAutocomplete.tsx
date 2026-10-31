import { useEffect, useRef, useState } from "react";

// Address autocomplete for the Add Patient form. Ported from the AWS
// patient app (client/src/components/AddressAutocomplete.tsx, built
// 2026-10-01) at Jake's direction — he asked for the component to be
// reused in Marc Innotech.
//
// Two suggestion engines behind the same dropdown UI:
// - Google Places (the default when VITE_GOOGLE_MAPS_API_KEY is
//   configured): Places API (New) autocomplete — Google's own
//   predictions, Chicagoland-biased (the same rectangle as the
//   Nominatim viewbox below), US-only, with a per-typing-session
//   token (Google's session billing model). Picking a suggestion
//   fetches Place Details for the structured address components.
// - OpenStreetMap Nominatim (fallback): free, no-key lookup used
//   when no Google key is configured or a Google lookup fails, so
//   the form never breaks. US-only, debounced, two-stage
//   (Chicagoland-bounded first, whole US second). The fallback is
//   exhaustive: it engages on ANY Google failure — an HTTP error
//   (e.g. the referrer-restricted browser key returns 403 on
//   per-deployment preview origins), a network error, a hung
//   request (the Google attempt is time-boxed), or a Google
//   response with zero usable predictions. A failed Place
//   Details call likewise resolves the picked label through
//   Nominatim before degrading to the raw prediction text.
// Either way, picking a suggestion fills street / city / state /
// postal code, and only the partial address text the user typed is
// sent to the lookup service — never a patient name.

// Structured address filled into the patient form when a suggestion is picked.
// latitude/longitude ride along for the Patients Map: both engines
// return a location with the address, and the form saves it with the
// patient (schema-patients-map.sql). Null when an engine has none.
export interface SuggestedAddress {
  street: string;
  city: string;
  state: string;
  postal_code: string;
  latitude: number | null;
  longitude: number | null;
}

interface NominatimResult {
  display_name: string;
  lat?: string;
  lon?: string;
  address?: {
    house_number?: string;
    road?: string;
    city?: string;
    town?: string;
    village?: string;
    hamlet?: string;
    state?: string;
    postcode?: string;
    "ISO3166-2-lvl4"?: string;
  };
}

interface Suggestion {
  label: string;
  address: SuggestedAddress;
  // Google Places only: details are fetched on pick (the autocomplete
  // response carries display text, not structured components).
  placeId?: string;
}

// Free, no-key address lookup (OpenStreetMap Nominatim). Debounced so we
// stay well under the 1 req/sec usage policy. Two-stage search: stage 1
// is bounded to Chicagoland (the clinic's metro area), so Nominatim
// searches only inside that bounding box — fast, and every result is
// local. Only when stage 1 finds nothing does stage 2 widen to the
// whole US (viewbox still set, so near-metro results rank first), which
// keeps out-of-area addresses findable without slowing the common case.
const AREA_VIEWBOX = "-88.500,42.510,-87.300,41.300";

async function fetchAddresses(
  q: string,
  bounded: "0" | "1",
  signal: AbortSignal,
): Promise<Suggestion[]> {
  const params = new URLSearchParams({
    format: "jsonv2",
    q,
    addressdetails: "1",
    countrycodes: "us",
    // Chicagoland bounding box: <west lon>,<north lat>,<east lon>,<south lat>.
    viewbox: AREA_VIEWBOX,
    bounded,
    limit: "6",
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`lookup failed (${res.status})`);
  const data = (await res.json()) as NominatimResult[];
  return data.map((r) => {
    const a = r.address ?? {};
    const street = [a.house_number, a.road].filter(Boolean).join(" ");
    // Prefer the 2-letter state code (ISO3166-2-lvl4 is like "US-OH").
    const iso = a["ISO3166-2-lvl4"];
    const state = (iso?.startsWith("US-") ? iso.slice(3) : "") || a.state || "";
    const lat = r.lat ? Number(r.lat) : NaN;
    const lon = r.lon ? Number(r.lon) : NaN;
    return {
      label: r.display_name,
      address: {
        street,
        city: a.city || a.town || a.village || a.hamlet || "",
        state,
        postal_code: a.postcode || "",
        latitude: Number.isFinite(lat) ? lat : null,
        longitude: Number.isFinite(lon) ? lon : null,
      },
    };
  });
}

async function searchAddresses(q: string, signal: AbortSignal): Promise<Suggestion[]> {
  // Stage 1: Chicagoland only.
  const local = await fetchAddresses(q, "1", signal);
  if (local.length) return local;
  // Stage 2: whole US (only reached when nothing matched in Chicagoland).
  const us = await fetchAddresses(q, "0", signal);
  // Illinois first, just in case (stable sort keeps Nominatim's order
  // within each group).
  us.sort(
    (x, y) =>
      (x.address.state === "IL" ? 0 : 1) -
      (y.address.state === "IL" ? 0 : 1),
  );
  return us;
}

// ------------------------------------------------------------------
// Google Places engine (Places API New). The key is a browser key,
// restricted by HTTP referrer + to the Places API in Cloud Console —
// it is frontend config by design, like the OAuth client ID.

function googleMapsKey(): string {
  const raw =
    (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? "";
  return raw.trim();
}

// Chicagoland bias rectangle — the same corners as AREA_VIEWBOX,
// expressed as lat/lng low/high for the Places API.
const BIAS_RECTANGLE = {
  low: { latitude: 41.3, longitude: -88.5 },
  high: { latitude: 42.51, longitude: -87.3 },
};

interface PlacePrediction {
  placeId?: string;
  text?: { text?: string };
  structuredFormat?: {
    mainText?: { text?: string };
    secondaryText?: { text?: string };
  };
}

async function searchGooglePlaces(
  q: string,
  sessionToken: string,
  signal: AbortSignal,
): Promise<Suggestion[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": googleMapsKey(),
    },
    body: JSON.stringify({
      input: q,
      sessionToken,
      languageCode: "en",
      includedRegionCodes: ["us"],
      locationBias: { rectangle: BIAS_RECTANGLE },
    }),
  });
  if (!res.ok) throw new Error(`google lookup failed (${res.status})`);
  const data = (await res.json()) as {
    suggestions?: { placePrediction?: PlacePrediction }[];
  };
  return (data.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is PlacePrediction => Boolean(p?.placeId))
    .map((p) => {
      const main = p.structuredFormat?.mainText?.text ?? "";
      const secondary = p.structuredFormat?.secondaryText?.text ?? "";
      return {
        label: p.text?.text ?? [main, secondary].filter(Boolean).join(", "),
        address: {
          street: main,
          city: "",
          state: "",
          postal_code: "",
          latitude: null,
          longitude: null,
        },
        placeId: p.placeId,
      };
    });
}

// The Google autocomplete attempt gets its own controller plus
// a hard time budget: without one, a hung Places request
// (stalled network, blocked endpoint) would leave the dropdown
// sitting on "Searching…" forever and the Nominatim fallback
// would never run. The attempt aborts when the budget expires
// OR when the caller's signal (keystroke cancellation) aborts.
const GOOGLE_TIMEOUT_MS = 4500;

async function searchGooglePlacesWithTimeout(
  q: string,
  sessionToken: string,
  parentSignal: AbortSignal,
): Promise<Suggestion[]> {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  if (parentSignal.aborted) ctrl.abort();
  else
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), GOOGLE_TIMEOUT_MS);
  try {
    return await searchGooglePlaces(q, sessionToken, ctrl.signal);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

interface AddressComponent {
  types?: string[];
  longText?: string;
  shortText?: string;
}

// Place Details for the picked prediction: the structured components
// are what fill the form (autocomplete text alone doesn't split into
// street / city / state / ZIP reliably).
async function fetchGooglePlace(
  placeId: string,
  sessionToken: string,
): Promise<SuggestedAddress> {
  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    {
      headers: {
        "X-Goog-Api-Key": googleMapsKey(),
        "X-Goog-FieldMask": "addressComponents,location",
        "X-Goog-Session-Token": sessionToken,
      },
    },
  );
  if (!res.ok) throw new Error(`place details failed (${res.status})`);
  const data = (await res.json()) as {
    addressComponents?: AddressComponent[];
    location?: { latitude?: number; longitude?: number };
  };
  const comp = (type: string) =>
    (data.addressComponents ?? []).find((c) => c.types?.includes(type));
  const street = [
    comp("street_number")?.longText,
    comp("route")?.longText,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    street,
    city:
      comp("locality")?.longText ||
      comp("sublocality_level_1")?.longText ||
      comp("postal_town")?.longText ||
      comp("administrative_area_level_2")?.longText ||
      "",
    // shortText of administrative_area_level_1 is the 2-letter code.
    state: comp("administrative_area_level_1")?.shortText || "",
    postal_code: comp("postal_code")?.longText || "",
    latitude:
      typeof data.location?.latitude === "number"
        ? data.location.latitude
        : null,
    longitude:
      typeof data.location?.longitude === "number"
        ? data.location.longitude
        : null,
  };
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSelectAddress: (a: SuggestedAddress) => void;
}

export default function AddressAutocomplete({ value, onChange, onSelectAddress }: Props) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [engine, setEngine] = useState<"google" | "osm">("osm");
  const wrapRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // One Places session token per typing session; rotated after every
  // pick (a session ends with the Place Details call — that's the
  // unit Google bills, and the token ties the two calls together).
  const sessionRef = useRef<string>(crypto.randomUUID());
  // Guards against a single tap firing pick() twice (pointerdown +
  // the compatibility click that follows it), which would fetch
  // Place Details twice for one selection.
  const pickGuardRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });

  // Debounced lookup as the user types.
  useEffect(() => {
    abortRef.current?.abort();
    if (value.trim().length < 3) {
      setSuggestions([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const useGoogle = googleMapsKey() !== "";
    const t = setTimeout(async () => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        if (useGoogle) {
          try {
            const results = await searchGooglePlacesWithTimeout(
              value.trim(),
              sessionRef.current,
              ctrl.signal,
            );
            if (results.length) {
              setSuggestions(results);
              setEngine("google");
              setHighlight(0);
              setOpen(true);
              return;
            }
            // Google answered but had nothing usable (e.g. every
            // prediction filtered out): fall through to Nominatim
            // instead of dead-ending on "No matches".
          } catch {
            // Google lookup failed (key restriction, quota,
            // network, or the time budget above): fall through to
            // the free engine so the form never breaks.
            if (ctrl.signal.aborted) return;
          }
        }
        const results = await searchAddresses(value.trim(), ctrl.signal);
        setSuggestions(results);
        setEngine("osm");
        setHighlight(results.length ? 0 : -1);
        setOpen(true);
      } catch {
        // Aborted or network error: just leave the field alone.
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [value]);

  // Close when clicking outside.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pick = async (s: Suggestion) => {
    const key = s.placeId ?? s.label;
    const now = Date.now();
    if (pickGuardRef.current.key === key && now - pickGuardRef.current.at < 700) return;
    pickGuardRef.current = { key, at: now };
    setOpen(false);
    if (s.placeId) {
      try {
        const address = await fetchGooglePlace(s.placeId, sessionRef.current);
        onSelectAddress(address);
      } catch {
        // Details failed: resolve the picked label through
        // Nominatim so the form still gets structured city /
        // state / ZIP and coordinates; last resort is the
        // prediction's main text as the street, with the rest
        // typed by hand.
        let fallback = s.address;
        try {
          const matches = await searchAddresses(
            s.label,
            new AbortController().signal,
          );
          if (matches.length) fallback = matches[0].address;
        } catch {
          // Keep the prediction-text fallback.
        }
        onSelectAddress(fallback);
      } finally {
        sessionRef.current = crypto.randomUUID();
      }
      return;
    }
    onSelectAddress(s.address);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || !suggestions.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" && highlight >= 0) {
      e.preventDefault();
      void pick(suggestions[highlight]);
    } else if (e.key === "Tab") {
      // Tab accepts the highlighted suggestion — or the first one
      // when nothing is highlighted yet — and fills the address
      // fields, instead of tabbing away and losing the list
      // (Jake's request, 2026-10-30). The dropdown closes on pick,
      // so the next Tab moves to the next field as usual. When the
      // list is closed or empty, Tab keeps its normal behavior.
      e.preventDefault();
      void pick(suggestions[highlight >= 0 ? highlight : 0]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="addr-wrap" ref={wrapRef}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => suggestions.length && setOpen(true)}
        placeholder="Start typing a street address…"
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && (
        <div className="addr-drop" role="listbox">
          {loading && <div className="addr-item addr-muted">Searching…</div>}
          {!loading && !suggestions.length && (
            <div className="addr-item addr-muted">No matches — keep typing</div>
          )}
          {suggestions.map((s, i) => (
            <div
              key={s.placeId ?? s.label}
              role="option"
              aria-selected={i === highlight}
              className={`addr-item${i === highlight ? " addr-hl" : ""}`}
              onPointerDown={(e) => {
                // Pointer events cover touch as well as mouse —
                // mouse-only handlers miss taps on some phones.
                e.preventDefault();
                void pick(s);
              }}
              onClick={() => {
                // Fallback for browsers that don't deliver
                // pointerdown on the dropdown (older mobile
                // browsers); the guard in pick() dedupes the
                // double-fire when both handlers run.
                void pick(s);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              {s.label}
            </div>
          ))}
          <div className="addr-attrib">
            {engine === "google"
              ? "Powered by Google"
              : "© OpenStreetMap contributors"}
          </div>
        </div>
      )}
    </div>
  );
}
