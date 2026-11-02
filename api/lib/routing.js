// Road-mile routing for mileage entries (2026-11-01).
//
// Uses the public Valhalla instance (same engine family as
// Jake's personal Trip Tracker) to price one leg two ways:
// the default route (tollways allowed) and the avoid-tolls
// route. The dashboard stores BOTH figures on the entry plus
// which one the clinician actually drove (used_tollway), so
// an expense report shows its work.
//
// Demo-grade infrastructure by design: if Valhalla is
// unreachable the caller gets nulls and the entry form falls
// back to hand-typed miles (miles are always correctable).
// Nothing here is allowed to block saving an entry.

const VALHALLA_URL =
  process.env.VALHALLA_URL || 'https://valhalla1.openstreetmap.de/route';
const TIMEOUT_MS = 10000;

// Pure parser (unit-tested without network): a Valhalla route
// response's trip length, in the units requested ('miles').
function parseValhallaMiles(json) {
  const len = json && json.trip && json.trip.summary
    ? json.trip.summary.length
    : null;
  return typeof len === 'number' && Number.isFinite(len) && len >= 0
    ? len
    : null;
}

async function valhallaRoute(from, to, excludeTolls) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(VALHALLA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        locations: [
          { lat: from.lat, lon: from.lng },
          { lat: to.lat, lon: to.lng },
        ],
        costing: 'auto',
        costing_options: { auto: { exclude_tolls: excludeTolls ? 1 : 0 } },
        units: 'miles',
        id: 'caretask-mileage',
      }),
    });
    if (!res.ok) return null;
    return parseValhallaMiles(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Both variants for one leg. Returns { milesToll, milesNoToll }
// where either may be null when that variant failed; throws
// only when BOTH failed (no route at all).
async function routeLeg(from, to) {
  const [milesToll, milesNoToll] = await Promise.all([
    valhallaRoute(from, to, false),
    valhallaRoute(from, to, true),
  ]);
  if (milesToll === null && milesNoToll === null) {
    const e = new Error('routing unavailable for this leg');
    e.code = 'ROUTE_FAILED';
    throw e;
  }
  return { milesToll, milesNoToll };
}

module.exports = { parseValhallaMiles, routeLeg };
