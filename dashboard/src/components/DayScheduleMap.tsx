import { useEffect, useMemo, useState } from "react";
import { Route } from "lucide-react";
import type { ApiAppointment } from "../lib/patientApi";
import type { TrafficLight } from "../lib/demoData";
import {
  geocodeFreeText,
  haversineMiles,
  nearestNeighborOrder,
  patientAddress,
  resolvePlacements,
  routeMiles,
  type MapPatientLike,
  type PlacedPoint,
} from "../lib/geo";
import PatientMap, { type MapMarker } from "./PatientMap";

// Day Schedule Map — one day's appointments as NUMBERED pins in
// scheduled time order, with the same placement rules as the
// Patients Map (stored coordinates → street geocode → approximate
// area fallback → listed as not placed; see lib/geo.ts).
//
// Route optimization is a SUGGESTION ONLY (company rule: the
// clinician keeps the judgment). It computes a nearest-neighbor
// visit order from the clinician's start address and displays it;
// it never writes to the appointments API and never changes a time
// or an order in the database.

const ZONE_COLORS: Record<TrafficLight, string> = {
  green: "#1d9d57",
  yellow: "#d9a406",
  red: "#d43a2f",
};
const START_ADDRESS_KEY = "caretask.routeStartAddress";

export interface DayMapPatient extends MapPatientLike {
  // MapPatientLike already carries everything needed.
}

interface Props {
  date: Date;
  onDateChange: (d: Date) => void;
  appointments: ApiAppointment[];
  patients: MapPatientLike[];
  onOpenPatient: (id: string) => void;
}

interface Stop {
  appointment: ApiAppointment;
  patient: MapPatientLike;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function DayScheduleMap({
  date,
  onDateChange,
  appointments,
  patients,
  onOpenPatient,
}: Props) {
  const stops: Stop[] = useMemo(() => {
    const byId = new Map(patients.map((p) => [p.id, p]));
    return appointments
      .filter(
        (a) =>
          a.patient_id &&
          a.status !== "cancelled" &&
          a.cattype === "appointment",
      )
      .sort((x, y) => +new Date(x.starts_at) - +new Date(y.starts_at))
      .map((a) => {
        const known = byId.get(a.patient_id as string);
        const patient: MapPatientLike = known ?? {
          id: a.patient_id as string,
          name: a.patient_name ?? "Patient",
          zone: "green",
        };
        return { appointment: a, patient };
      });
  }, [appointments, patients]);

  const [placedByPatient, setPlacedByPatient] = useState<
    Map<string, PlacedPoint>
  >(new Map());
  const [notPlacedIds, setNotPlacedIds] = useState<Set<string>>(new Set());
  const [resolving, setResolving] = useState(false);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);

  // Route optimization state (suggestion only — display state, the
  // appointments themselves are never touched).
  const [startAddress, setStartAddress] = useState<string>(() => {
    try {
      return localStorage.getItem(START_ADDRESS_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [optimizedIds, setOptimizedIds] = useState<string[] | null>(null);
  const [startPoint, setStartPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [optMiles, setOptMiles] = useState<number | null>(null);
  const [optError, setOptError] = useState("");
  const [optBusy, setOptBusy] = useState(false);

  const uniquePatients = useMemo(() => {
    const seen = new Map<string, MapPatientLike>();
    for (const s of stops) if (!seen.has(s.patient.id)) seen.set(s.patient.id, s.patient);
    return [...seen.values()];
  }, [stops]);

  useEffect(() => {
    let live = true;
    setOptimizedIds(null);
    setStartPoint(null);
    setOptMiles(null);
    setOptError("");
    if (!uniquePatients.length) {
      setPlacedByPatient(new Map());
      setNotPlacedIds(new Set());
      return;
    }
    setResolving(true);
    void resolvePlacements(uniquePatients).then((result) => {
      if (!live) return;
      setPlacedByPatient(
        new Map(result.placed.map((p) => [p.patient.id, p])),
      );
      setNotPlacedIds(new Set(result.notPlaced.map((p) => p.id)));
      setResolving(false);
    });
    return () => {
      live = false;
    };
  }, [uniquePatients]);

  const placedStops = useMemo(
    () =>
      stops
        .map((s) => ({ stop: s, placed: placedByPatient.get(s.patient.id) }))
        .filter(
          (x): x is { stop: Stop; placed: PlacedPoint } => Boolean(x.placed),
        ),
    [stops, placedByPatient],
  );
  const unplacedStops = useMemo(
    () => stops.filter((s) => notPlacedIds.has(s.patient.id)),
    [stops, notPlacedIds],
  );

  const displayStops = useMemo(() => {
    if (!optimizedIds) return placedStops;
    const byAppt = new Map(placedStops.map((x) => [x.stop.appointment.id, x]));
    const ordered = optimizedIds
      .map((id) => byAppt.get(id))
      .filter((x): x is { stop: Stop; placed: PlacedPoint } => Boolean(x));
    // Any placed stop missing from the optimized list (e.g. placed
    // after optimizing) keeps its scheduled position at the end.
    for (const x of placedStops) {
      if (!optimizedIds.includes(x.stop.appointment.id)) ordered.push(x);
    }
    return ordered;
  }, [placedStops, optimizedIds]);

  const orderDiffers = useMemo(() => {
    if (!optimizedIds) return false;
    const scheduled = placedStops.map((x) => x.stop.appointment.id);
    return JSON.stringify(optimizedIds) !== JSON.stringify(scheduled);
  }, [optimizedIds, placedStops]);

  const markers: MapMarker[] = displayStops.map((x, i) => ({
    id: x.stop.appointment.id,
    lat: x.placed.lat,
    lon: x.placed.lon,
    color: ZONE_COLORS[x.stop.patient.zone] ?? "#2563eb",
    number: i + 1,
    approximate: x.placed.approximate,
    selected: selectedStopId === x.stop.appointment.id,
    popupTitle: `${i + 1}. ${x.stop.patient.name}`,
    popupLines: [
      `${fmtTime(x.stop.appointment.starts_at)} · ${x.stop.appointment.category_name}`,
      patientAddress(x.stop.patient) || "No address on file",
    ],
    openProfileId: x.stop.patient.id,
  }));
  if (startPoint && optimizedIds) {
    markers.unshift({
      id: "__start",
      lat: startPoint.lat,
      lon: startPoint.lon,
      color: "#5b6472",
      label: "S",
      popupTitle: "Start",
      popupLines: [startAddress],
    });
  }

  const routeLine = useMemo(() => {
    const pts = displayStops.map((x) => ({ lat: x.placed.lat, lon: x.placed.lon }));
    if (optimizedIds && startPoint) return [startPoint, ...pts];
    return pts;
  }, [displayStops, optimizedIds, startPoint]);

  async function optimize() {
    setOptError("");
    const addr = startAddress.trim();
    if (!addr) {
      setOptError("Enter a start address (e.g. your home) to optimize the route.");
      return;
    }
    if (!placedStops.length) {
      setOptError("No placed visits for this day yet — nothing to optimize.");
      return;
    }
    setOptBusy(true);
    try {
      try {
        localStorage.setItem(START_ADDRESS_KEY, addr);
      } catch {
        // Private mode: the address still applies for this session.
      }
      const start = await geocodeFreeText(addr);
      if (!start) {
        setOptError(
          "Couldn't locate that start address — check it and try again.",
        );
        return;
      }
      const points = placedStops.map((x) => ({
        appointmentId: x.stop.appointment.id,
        lat: x.placed.lat,
        lon: x.placed.lon,
      }));
      const ordered = nearestNeighborOrder(start, points);
      setStartPoint(start);
      setOptimizedIds(ordered.map((p) => p.appointmentId));
      setOptMiles(routeMiles(start, ordered));
      setSelectedStopId(null);
    } finally {
      setOptBusy(false);
    }
  }

  function clearOptimization() {
    setOptimizedIds(null);
    setStartPoint(null);
    setOptMiles(null);
    setOptError("");
  }

  const googleMapsUrl = useMemo(() => {
    if (!optimizedIds || !startPoint) return null;
    const coord = (p: { lat: number; lon: number }) => `${p.lat},${p.lon}`;
    const stopsPts = displayStops.map((x) => ({
      lat: x.placed.lat,
      lon: x.placed.lon,
    }));
    if (!stopsPts.length) return null;
    const params = new URLSearchParams({
      api: "1",
      origin: startAddress.trim() || coord(startPoint),
      destination: coord(stopsPts[stopsPts.length - 1]),
    });
    if (stopsPts.length > 1) {
      params.set(
        "waypoints",
        stopsPts.slice(0, -1).map(coord).join("|"),
      );
    }
    return `https://www.google.com/maps/dir/?${params}`;
  }, [optimizedIds, startPoint, displayStops, startAddress]);

  return (
    <div>
      <div className="cal-toolbar">
        <div className="cal-nav">
          <label>
            Day{" "}
            <input
              type="date"
              value={toDateInput(date)}
              onChange={(e) => {
                const [y, m, d] = e.target.value.split("-").map(Number);
                if (y && m && d) onDateChange(new Date(y, m - 1, d));
              }}
            />
          </label>
          <span className="card-meta">
            All providers · {stops.length} visit{stops.length === 1 ? "" : "s"}
            {resolving && " · placing…"}
          </span>
        </div>
      </div>

      {stops.length === 0 && (
        <p className="section-note">
          No appointments with patients on this day.
        </p>
      )}

      {stops.length > 0 && (
        <>
          <PatientMap
            markers={markers}
            routeLine={routeLine.length > 1 ? routeLine : null}
            selectedId={selectedStopId}
            onSelect={(id) => {
              if (id !== "__start") setSelectedStopId(id);
            }}
            onOpenProfile={onOpenPatient}
            height={440}
          />
          <ol className="map-day-list">
            {displayStops.map((x, i) => (
              <li key={x.stop.appointment.id}>
                <button
                  type="button"
                  className={
                    selectedStopId === x.stop.appointment.id
                      ? "map-day-row selected"
                      : "map-day-row"
                  }
                  onClick={() => setSelectedStopId(x.stop.appointment.id)}
                >
                  <span className="map-day-num">{i + 1}</span>
                  <span>
                    {fmtTime(x.stop.appointment.starts_at)} —{" "}
                    {x.stop.patient.name} · {x.stop.appointment.category_name}
                    {x.placed.approximate && " · approximate (area only)"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {unplacedStops.length > 0 && (
            <article className="card">
              <h3>Not placed</h3>
              <ul className="map-notplaced">
                {unplacedStops.map((s) => (
                  <li key={s.appointment.id}>
                    {fmtTime(s.appointment.starts_at)} — {s.patient.name} —{" "}
                    {patientAddress(s.patient) || "no address on file"}
                  </li>
                ))}
              </ul>
            </article>
          )}

          <article className="card">
            <h3>
              <Route size={18} aria-hidden /> Optimize route — suggestion only
            </h3>
            <p className="section-note">
              Suggests a visit order that avoids backtracking, starting
              from the address below. It never changes appointment times
              or the schedule in the database — the clinician decides
              whether to use it.
            </p>
            <div className="map-opt-row">
              <label>
                Start address{" "}
                <input
                  type="text"
                  value={startAddress}
                  onChange={(e) => setStartAddress(e.target.value)}
                  placeholder="e.g. your home address"
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void optimize()}
                disabled={optBusy}
              >
                {optBusy ? "Optimizing…" : "Optimize route"}
              </button>
              {optimizedIds && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={clearOptimization}
                >
                  Back to scheduled order
                </button>
              )}
            </div>
            {optError && <p className="pin-error">{optError}</p>}
            {optimizedIds && optMiles !== null && (
              <p className="section-note">
                Suggested order shown above. Estimated total:{" "}
                <strong>{optMiles.toFixed(1)} miles</strong> (straight-line
                estimate between stops — road distance will be longer).
                {orderDiffers &&
                  " The suggested order differs from the scheduled appointment times — check the times before using it."}
              </p>
            )}
            {googleMapsUrl && (
              <p>
                <a href={googleMapsUrl} target="_blank" rel="noreferrer">
                  Open in Google Maps
                </a>{" "}
                — directions for the suggested order (free link, no API
                key).
              </p>
            )}
            {startPoint && optimizedIds && (
              <p className="section-note">
                Legs from start:{" "}
                {displayStops
                  .map((x, i, arr) => {
                    const from = i === 0 ? startPoint : arr[i - 1].placed;
                    return `${haversineMiles(
                      { lat: from.lat, lon: from.lon },
                      { lat: x.placed.lat, lon: x.placed.lon },
                    ).toFixed(1)} mi to ${x.stop.patient.name}`;
                  })
                  .join(" · ")}
              </p>
            )}
          </article>
        </>
      )}
    </div>
  );
}
