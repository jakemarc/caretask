// Geocoding + placement helpers for the Patients Map and the
// day-schedule map (CareTask maps build, 2026-10-30).
//
// Placement rules, in order:
//   1. Stored coordinates on the patient record (saved when an
//      address-autocomplete suggestion was picked) — exact pin.
//   2. Nominatim geocode of the full street address — exact pin.
//   3. Nominatim geocode of city/state/ZIP only — APPROXIMATE pin
//      ("area only"): the pin sits on the area centroid, never on a
//      fabricated street location.
//   4. Nothing matched — the patient is reported as not placed and
//      listed by name + address; never silently dropped.
//
// Nominatim courtesy: lookups run strictly sequentially with ~1.1s
// spacing (its usage policy is 1 req/sec), and results are cached
// in memory for the session so re-renders and view switches do not
// re-ask. Only address text is sent — never a patient name.

import type { PersonUnderCare, TrafficLight } from "./demoData";

export interface MapPatientLike {
  id: string;
  name: string;
  zone: TrafficLight;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface PlacedPoint {
  patient: MapPatientLike;
  lat: number;
  lon: number;
  approximate: boolean;
  /** True when the coordinates came from the patient record. */
  stored: boolean;
}

export interface PlacementResult {
  placed: PlacedPoint[];
  notPlaced: MapPatientLike[];
}

export function patientAddress(p: MapPatientLike): string {
  return [p.street, p.city, p.state, p.postalCode]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

export function toMapPatient(p: PersonUnderCare): MapPatientLike {
  return {
    id: p.id,
    name: p.name,
    zone: p.status,
    street: p.street,
    city: p.city,
    state: p.state,
    postalCode: p.postalCode,
    latitude: p.latitude,
    longitude: p.longitude,
  };
}

// ----------------------------------------------------------------
// Haversine distance (miles) + nearest-neighbor ordering — the same
// approach as Jake's personal scheduling tool engine.

const EARTH_RADIUS_MI = 3958.8;

export function haversineMiles(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(s));
}

/** Greedy nearest-neighbor order starting from `start`. Input order
 * is preserved for exact ties so results are deterministic. */
export function nearestNeighborOrder<T extends { lat: number; lon: number }>(
  start: { lat: number; lon: number },
  points: T[],
): T[] {
  const remaining = [...points];
  const ordered: T[] = [];
  let current = start;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMiles(current, remaining[i]);
      if (d < bestDist - 1e-9) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const [next] = remaining.splice(bestIdx, 1);
    ordered.push(next);
    current = next;
  }
  return ordered;
}

/** Total straight-line miles along start → points in the given order. */
export function routeMiles(
  start: { lat: number; lon: number },
  points: { lat: number; lon: number }[],
): number {
  let total = 0;
  let current = start;
  for (const p of points) {
    total += haversineMiles(current, p);
    current = p;
  }
  return total;
}

// ----------------------------------------------------------------
// Nominatim geocoding (free, no key). One shared rate-limit chain so
// every caller in the app shares the same ~1/sec courtesy spacing.

const geocodeCache = new Map<string, { lat: number; lon: number } | null>();
let geocodeChain: Promise<unknown> = Promise.resolve();
let lastGeocodeAt = 0;

async function nominatimSearch(
  query: string,
): Promise<{ lat: number; lon: number } | null> {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null;
  const run = async () => {
    if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null;
    const wait = 1100 - (Date.now() - lastGeocodeAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeocodeAt = Date.now();
    let out: { lat: number; lon: number } | null = null;
    try {
      const params = new URLSearchParams({
        format: "jsonv2",
        q: query,
        countrycodes: "us",
        limit: "1",
      });
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.ok) {
        const data = (await res.json()) as { lat?: string; lon?: string }[];
        const first = data[0];
        if (first?.lat && first?.lon) {
          const lat = Number(first.lat);
          const lon = Number(first.lon);
          if (Number.isFinite(lat) && Number.isFinite(lon)) out = { lat, lon };
        }
      }
    } catch {
      out = null;
    }
    geocodeCache.set(key, out);
    return out;
  };
  const result = geocodeChain.then(run, run);
  geocodeChain = result.catch(() => undefined);
  return result;
}

/** Geocode a free-text address (used for the route start point). */
export async function geocodeFreeText(
  query: string,
): Promise<{ lat: number; lon: number } | null> {
  return nominatimSearch(query);
}

// Deterministic small offset for pins that share identical
// coordinates (the demo case: every Springfield/Example patient
// falls back to the same ZIP centroid). Golden-angle spiral,
// ~120 m per step — pins stay in the same area and remain visibly
// approximate; no distinct street location is invented.
function spreadOffsets(points: PlacedPoint[]): PlacedPoint[] {
  const groups = new Map<string, PlacedPoint[]>();
  for (const p of points) {
    const k = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
    const arr = groups.get(k) ?? [];
    arr.push(p);
    groups.set(k, arr);
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    arr.forEach((p, i) => {
      if (i === 0) return;
      const angle = i * 2.399963; // golden angle, radians
      const radius = 0.0016 * Math.sqrt(i); // degrees (~120–350 m)
      p.lat += radius * Math.cos(angle);
      p.lon += radius * Math.sin(angle);
    });
  }
  return points;
}

/**
 * Resolve placements for a set of patients. Sequential by design
 * (Nominatim courtesy). `onProgress` fires after each patient so a
 * view can render pins as they land instead of blocking on the
 * slowest lookup.
 */
export async function resolvePlacements(
  patients: MapPatientLike[],
  onProgress?: (result: PlacementResult) => void,
): Promise<PlacementResult> {
  const placed: PlacedPoint[] = [];
  const notPlaced: MapPatientLike[] = [];
  const snapshot = (): PlacementResult => ({
    placed: spreadOffsets(placed.map((p) => ({ ...p }))),
    notPlaced: [...notPlaced],
  });
  for (const patient of patients) {
    if (
      typeof patient.latitude === "number" &&
      typeof patient.longitude === "number"
    ) {
      placed.push({
        patient,
        lat: patient.latitude,
        lon: patient.longitude,
        approximate: false,
        stored: true,
      });
      onProgress?.(snapshot());
      continue;
    }
    const streetQuery = patientAddress(patient);
    let point: PlacedPoint | null = null;
    if (streetQuery) {
      const hit = await nominatimSearch(streetQuery);
      if (hit) {
        point = { patient, ...hit, approximate: false, stored: false };
      } else {
        const areaQuery = [patient.city, patient.state, patient.postalCode]
          .map((part) => (part ?? "").trim())
          .filter(Boolean)
          .join(", ");
        if (areaQuery && areaQuery !== streetQuery) {
          const centroid = await nominatimSearch(areaQuery);
          if (centroid) {
            point = { patient, ...centroid, approximate: true, stored: false };
          }
        }
      }
    }
    if (point) placed.push(point);
    else notPlaced.push(patient);
    onProgress?.(snapshot());
  }
  return snapshot();
}
