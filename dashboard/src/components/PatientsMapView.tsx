import { useEffect, useMemo, useState } from "react";
import { MapPin } from "lucide-react";
import type { PersonUnderCare, TrafficLight } from "../lib/demoData";
import {
  patientAddress,
  resolvePlacements,
  toMapPatient,
  type PlacementResult,
} from "../lib/geo";
import PatientMap, { type MapMarker } from "./PatientMap";

// Patients Map — every patient as a pin, colored by zone
// (green / yellow / red). Patients with stored coordinates (saved
// from an autocomplete pick) pin exactly; the rest are geocoded on
// load (street first, then an APPROXIMATE area-level fallback —
// see lib/geo.ts). The demo seed patients use fictional "Example"
// street addresses in Springfield, IL, so in the demo they land as
// approximate ZIP-level pins, which is exactly what the approximate
// styling is for.

const ZONE_COLORS: Record<TrafficLight, string> = {
  green: "#1d9d57",
  yellow: "#d9a406",
  red: "#d43a2f",
};

interface Props {
  patients: PersonUnderCare[];
  onOpenPatient: (id: string) => void;
}

export default function PatientsMapView({ patients, onOpenPatient }: Props) {
  const [zoneFilter, setZoneFilter] = useState<TrafficLight | "all">("all");
  const [placement, setPlacement] = useState<PlacementResult>({
    placed: [],
    notPlaced: [],
  });
  const [resolving, setResolving] = useState(true);

  const mapPatients = useMemo(() => patients.map(toMapPatient), [patients]);

  useEffect(() => {
    let live = true;
    setResolving(true);
    void resolvePlacements(mapPatients, (partial) => {
      if (live) setPlacement(partial);
    }).then((final) => {
      if (live) {
        setPlacement(final);
        setResolving(false);
      }
    });
    return () => {
      live = false;
    };
  }, [mapPatients]);

  const visible = useMemo(
    () =>
      placement.placed.filter(
        (p) => zoneFilter === "all" || p.patient.zone === zoneFilter,
      ),
    [placement, zoneFilter],
  );
  const visibleNotPlaced = useMemo(
    () =>
      placement.notPlaced.filter(
        (p) => zoneFilter === "all" || p.zone === zoneFilter,
      ),
    [placement, zoneFilter],
  );

  const markers: MapMarker[] = visible.map((p) => ({
    id: p.patient.id,
    lat: p.lat,
    lon: p.lon,
    color: ZONE_COLORS[p.patient.zone],
    approximate: p.approximate,
    popupTitle: p.patient.name,
    popupLines: [
      `${p.patient.zone[0].toUpperCase()}${p.patient.zone.slice(1)} Zone`,
      patientAddress(p.patient) || "No address on file",
    ],
    openProfileId: p.patient.id,
  }));

  const counts = useMemo(() => {
    const by = { green: 0, yellow: 0, red: 0 } as Record<TrafficLight, number>;
    for (const p of patients) by[p.status] += 1;
    return by;
  }, [patients]);

  const chips: { key: TrafficLight | "all"; label: string }[] = [
    { key: "all", label: `All (${patients.length})` },
    { key: "green", label: `Green (${counts.green})` },
    { key: "yellow", label: `Yellow (${counts.yellow})` },
    { key: "red", label: `Red (${counts.red})` },
  ];

  const approximateCount = visible.filter((p) => p.approximate).length;

  return (
    <section>
      <h1>
        <MapPin size={22} aria-hidden /> Patients Map
      </h1>
      <p className="section-note">
        One pin per patient, colored by zone. Solid pins are street-level
        locations; hollow pins with a dashed ring are approximate — area
        only (city/ZIP level), never a fabricated street address.
      </p>
      <div className="map-chips" role="group" aria-label="Filter by zone">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className={
              zoneFilter === c.key ? "btn btn-primary" : "btn btn-secondary"
            }
            onClick={() => setZoneFilter(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {resolving && (
        <p className="section-note">
          Placing patients on the map… (addresses are looked up one at a
          time, so pins appear as they resolve)
        </p>
      )}
      <PatientMap
        markers={markers}
        onOpenProfile={onOpenPatient}
        height={480}
      />
      <p className="section-note">
        {visible.length} of {patients.length} patients shown
        {approximateCount > 0 &&
          ` — ${approximateCount} approximate (area-level)`}
        . Map data © OpenStreetMap contributors.
      </p>
      {visibleNotPlaced.length > 0 && (
        <article className="card">
          <h3>Not placed</h3>
          <p className="section-note">
            These patients could not be located from the address on file,
            so they are listed here instead of being pinned:
          </p>
          <ul className="map-notplaced">
            {visibleNotPlaced.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => onOpenPatient(p.id)}
                >
                  {p.name}
                </button>{" "}
                — {patientAddress(p) || "no address on file"}
              </li>
            ))}
          </ul>
        </article>
      )}
    </section>
  );
}
