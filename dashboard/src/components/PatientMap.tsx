import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Shared Leaflet map for the CareTask map views (Patients Map +
// day-schedule map). Leaflet is driven imperatively inside a ref'd
// container — no react-leaflet dependency — with OpenStreetMap
// tiles (free, no API key; attribution shown on the map).
//
// Pins are divIcons, so no marker-image assets are needed:
// - solid circle in the patient's zone color (or the supplied color)
// - numbered pins when `number` is set (day map: visit order)
// - APPROXIMATE pins are hollow with a dashed grey ring, so an
//   area-level placement never looks like a street address.

export interface MapMarker {
  id: string;
  lat: number;
  lon: number;
  color: string;
  number?: number;
  /** Short label inside the pin when no number is set (e.g. "S" for start). */
  label?: string;
  approximate?: boolean;
  selected?: boolean;
  popupTitle: string;
  popupLines: string[];
  /** When set, the popup shows an "Open profile" button. */
  openProfileId?: string;
}

interface Props {
  markers: MapMarker[];
  /** Ordered points to connect with a route line (day map). */
  routeLine?: { lat: number; lon: number }[] | null;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onOpenProfile?: (id: string) => void;
  height?: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pinIcon(m: MapMarker): L.DivIcon {
  const cls = [
    "ct-pin",
    m.approximate ? "ct-pin-approx" : "",
    m.selected ? "ct-pin-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const label = m.number !== undefined ? String(m.number) : (m.label ?? "");
  return L.divIcon({
    className: "ct-pin-wrap",
    html: `<div class="${cls}" style="--pin-color:${m.color}">${label}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14],
  });
}

export default function PatientMap({
  markers,
  routeLine,
  selectedId,
  onSelect,
  onOpenProfile,
  height = 440,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const markerById = useRef(new Map<string, L.Marker>());
  // Callbacks in refs so the marker layer effect does not need to
  // re-run (and re-create every marker) when a parent re-renders.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onOpenProfileRef = useRef(onOpenProfile);
  onOpenProfileRef.current = onOpenProfile;

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { scrollWheelZoom: true });
    map.setView([41.85, -87.65], 9); // Chicagoland default framing
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      markerById.current.clear();
    };
  }, []);

  // Sync markers + optional route line.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    markerById.current.clear();
    for (const m of markers) {
      const marker = L.marker([m.lat, m.lon], { icon: pinIcon(m) });
      const lines = m.popupLines
        .map((line) => `<div>${escapeHtml(line)}</div>`)
        .join("");
      const approx = m.approximate
        ? `<div class="ct-popup-approx">Approximate — area only</div>`
        : "";
      const button = m.openProfileId
        ? `<button type="button" class="ct-popup-btn" data-open-profile="${escapeHtml(m.openProfileId)}">Open profile</button>`
        : "";
      marker.bindPopup(
        `<div class="ct-popup"><strong>${escapeHtml(m.popupTitle)}</strong>${lines}${approx}${button}</div>`,
      );
      marker.on("click", () => onSelectRef.current?.(m.id));
      marker.on("popupopen", (e) => {
        const el = (e as L.PopupEvent).popup.getElement();
        const btn = el?.querySelector<HTMLButtonElement>("[data-open-profile]");
        if (btn) {
          btn.addEventListener("click", () => {
            const id = btn.getAttribute("data-open-profile");
            if (id) onOpenProfileRef.current?.(id);
          });
        }
      });
      marker.addTo(layer);
      markerById.current.set(m.id, marker);
    }
    if (routeLine && routeLine.length > 1) {
      L.polyline(
        routeLine.map((p) => [p.lat, p.lon] as [number, number]),
        { color: "#2563eb", weight: 3, opacity: 0.7, dashArray: "6 6" },
      ).addTo(layer);
    }
    if (markers.length) {
      const bounds = L.latLngBounds(
        markers.map((m) => [m.lat, m.lon] as [number, number]),
      );
      map.fitBounds(bounds.pad(0.15), { maxZoom: 13 });
    }
  }, [markers, routeLine]);

  // Open the popup for an externally selected marker (list click).
  useEffect(() => {
    if (!selectedId) return;
    const marker = markerById.current.get(selectedId);
    if (marker) marker.openPopup();
  }, [selectedId, markers]);

  return (
    <div
      ref={containerRef}
      className="ct-map"
      style={{ height }}
      role="application"
      aria-label="Patient locations map"
    />
  );
}
