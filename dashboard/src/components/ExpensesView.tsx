// Mileage view (2026-11-02, Jake's simplification) — a
// per-day chain log plus generated expense reports. No
// approval process: log the day's driving as a chain of legs,
// generate a report for any month / date range, filtered by
// agency.
//
// The chain: Home -> Office bookends are fixed PERSONAL legs
// (addresses from the clinician's staff profile and the
// agency profile; their miles snapshot onto the day's legs,
// so later address changes never rewrite history). Stops in
// between are billable legs in visit order, ending back at
// the office. Every leg's start and end can be set by tapping
// a known place (Home / Office / a patient) or typing an
// address with autocomplete. Routing defaults to the tollway
// figure; a per-leg toggle marks back roads instead, and
// miles stay hand-correctable after routing.
import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import {
  Building2,
  Check,
  Home,
  MapPin,
  Pencil,
  Plus,
  Printer,
  Trash2,
  X,
} from "lucide-react";
import AddressAutocomplete, {
  type SuggestedAddress,
} from "./AddressAutocomplete";
import type { PersonUnderCare } from "../lib/demoData";
import { fetchAgencies, type ApiAgency } from "../lib/patientApi";
import { geocodeFreeText } from "../lib/geo";
import {
  createMileage,
  deleteMileage,
  fetchMileage,
  fetchMileageReport,
  routeMiles,
  updateMileage,
  type MileageEntry,
  type MileageReport,
} from "../lib/expensesApi";
import { useMyStaff } from "../lib/useMyRole";

// ---------- small helpers ----------

function todayStr(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function monthRange(monthValue: string): { from: string; to: string } {
  const [y, m] = monthValue.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return {
    from: `${monthValue}-01`,
    to: `${monthValue}-${`${last}`.padStart(2, "0")}`,
  };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function prettyDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function joinAddress(
  street?: string | null,
  city?: string | null,
  state?: string | null,
  zip?: string | null,
): string {
  const cityState = [city, state].filter(Boolean).join(", ");
  return [street, cityState, zip].filter(Boolean).join(", ");
}

function suggestedToAddress(a: SuggestedAddress): string {
  return joinAddress(a.street, a.city, a.state, a.postal_code);
}

function errText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- chain model ----------

type StopKind = "home" | "office" | "patient" | "custom";

interface Stop {
  key: string;
  kind: StopKind;
  label: string;
  address: string;
  lat: number | null;
  lng: number | null;
  patient_id: string | null;
}

interface LegState {
  miles_toll: number | null;
  miles_no_toll: number | null;
  used_tollway: boolean;
  miles: string;
  kind_override: "business" | "commute" | null;
  saved_id: number | null;
  routed_sig: string;
  routing: boolean;
  route_failed: boolean;
}

const blankLeg = (): LegState => ({
  miles_toll: null,
  miles_no_toll: null,
  used_tollway: true,
  miles: "",
  kind_override: null,
  saved_id: null,
  routed_sig: "",
  routing: false,
  route_failed: false,
});

let stopSeq = 0;
const nextKey = () => `stop-${(stopSeq += 1)}`;

function legKind(
  from: Stop,
  to: Stop,
  override: "business" | "commute" | null,
): "business" | "commute" {
  if (override) return override;
  const bookend =
    (from.kind === "home" && to.kind === "office") ||
    (from.kind === "office" && to.kind === "home");
  return bookend ? "commute" : "business";
}

function stopFromEndpoint(
  label: string | null,
  address: string | null,
  lat: number | null,
  lng: number | null,
  patientId: string | null,
  officeLabel: string,
): Stop {
  const kind: StopKind = patientId
    ? "patient"
    : label === "Home"
      ? "home"
      : label === officeLabel
        ? "office"
        : "custom";
  return {
    key: nextKey(),
    kind,
    label: label ?? "",
    address: address ?? "",
    lat,
    lng,
    patient_id: patientId,
  };
}

// ---------- component ----------

export default function ExpensesView({
  user,
  people,
  apiConnected,
  autoOpenCurrent = false,
}: {
  user: User;
  people: PersonUnderCare[];
  apiConnected: boolean;
  // Opened from the mobile Mileage pill: the day log defaults
  // to today, which is exactly what this view opens on.
  autoOpenCurrent?: boolean;
}) {
  void autoOpenCurrent;
  const me = useMyStaff(user);

  const [agencies, setAgencies] = useState<ApiAgency[] | null>(null);
  const [agencyId, setAgencyId] = useState<number | null>(null);
  const [date, setDate] = useState(todayStr());
  const [stops, setStops] = useState<Stop[]>([]);
  const [legs, setLegs] = useState<LegState[]>([]);
  const [loadedIds, setLoadedIds] = useState<number[]>([]);
  const [dayLoaded, setDayLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [rate, setRate] = useState<string>(
    () => localStorage.getItem("caretask-mileage-rate") ?? "0.70",
  );

  const [repMode, setRepMode] = useState<"month" | "range">("month");
  const [repMonth, setRepMonth] = useState(() => todayStr().slice(0, 7));
  const [repFrom, setRepFrom] = useState(() => monthRange(todayStr().slice(0, 7)).from);
  const [repTo, setRepTo] = useState(() => monthRange(todayStr().slice(0, 7)).to);
  const [repAgency, setRepAgency] = useState<number | null>(null);
  const [report, setReport] = useState<MileageReport | null>(null);
  const [repBusy, setRepBusy] = useState(false);

  const officeCache = useRef(new Map<number, Stop>());
  const homeCache = useRef<Stop | null>(null);

  const agency = agencies?.find((a) => a.id === agencyId) ?? null;

  // ---------- endpoint resolution ----------

  const homeStop = useCallback(async (): Promise<Stop | null> => {
    if (homeCache.current) return homeCache.current;
    if (!me) return null;
    const address = joinAddress(me.street, me.city, me.state, me.zip);
    if (!address) return null;
    const geo = await geocodeFreeText(address);
    const stop: Stop = {
      key: nextKey(),
      kind: "home",
      label: "Home",
      address,
      lat: geo?.lat ?? null,
      lng: geo?.lon ?? null,
      patient_id: null,
    };
    homeCache.current = stop;
    return stop;
  }, [me]);

  const officeStop = useCallback(
    async (a: ApiAgency): Promise<Stop | null> => {
      const cached = officeCache.current.get(a.id);
      if (cached) return cached;
      const address = joinAddress(a.street, a.city, a.state, a.postal_code);
      if (!address) return null;
      const geo = await geocodeFreeText(address);
      const stop: Stop = {
        key: nextKey(),
        kind: "office",
        label: a.display_name,
        address,
        lat: geo?.lat ?? null,
        lng: geo?.lon ?? null,
        patient_id: null,
      };
      officeCache.current.set(a.id, stop);
      return stop;
    },
    [],
  );

  // ---------- day loading ----------

  const loadDay = useCallback(
    async (forDate: string, forAgency: number | null, agencyList: ApiAgency[]) => {
      setError("");
      setNotice("");
      setEditingKey(null);
      const entries = await fetchMileage(user, {
        from: forDate,
        to: forDate,
        agency_id: forAgency,
      });
      const ag = agencyList.find((a) => a.id === forAgency) ?? null;
      const oLabel = ag?.display_name ?? "Office";
      if (entries.length) {
        const rebuilt: Stop[] = [
          stopFromEndpoint(
            entries[0].start_label,
            entries[0].start_address,
            entries[0].start_lat,
            entries[0].start_lng,
            null,
            oLabel,
          ),
        ];
        const rebuiltLegs: LegState[] = [];
        for (const e of entries) {
          rebuilt.push(
            stopFromEndpoint(
              e.end_label,
              e.end_address,
              e.end_lat,
              e.end_lng,
              e.patient_id,
              oLabel,
            ),
          );
          rebuiltLegs.push({
            miles_toll: e.miles_toll,
            miles_no_toll: e.miles_no_toll,
            used_tollway: e.used_tollway,
            miles: e.business_miles ? String(e.business_miles) : "",
            kind_override:
              (e.entry_kind === "commute" &&
                !(
                  (rebuilt[rebuilt.length - 2].kind === "home" &&
                    rebuilt[rebuilt.length - 1].kind === "office") ||
                  (rebuilt[rebuilt.length - 2].kind === "office" &&
                    rebuilt[rebuilt.length - 1].kind === "home")
                )) ||
              (e.entry_kind === "business" &&
                ((rebuilt[rebuilt.length - 2].kind === "home" &&
                  rebuilt[rebuilt.length - 1].kind === "office") ||
                  (rebuilt[rebuilt.length - 2].kind === "office" &&
                    rebuilt[rebuilt.length - 1].kind === "home")))
                ? e.entry_kind
                : null,
            saved_id: e.id,
            routed_sig:
              e.start_lat !== null && e.end_lat !== null
                ? `${e.start_lat},${e.start_lng}->${e.end_lat},${e.end_lng}`
                : "",
            routing: false,
            route_failed: false,
          });
        }
        setStops(rebuilt);
        setLegs(rebuiltLegs);
        setLoadedIds(entries.map((e) => e.id));
      } else {
        // Fresh day: prefill the fixed bookends when both
        // addresses are known.
        const home = await homeStop();
        const office = ag ? await officeStop(ag) : null;
        if (home && office) {
          setStops([
            { ...home, key: nextKey() },
            { ...office, key: nextKey() },
            { ...home, key: nextKey() },
          ]);
          setLegs([blankLeg(), blankLeg()]);
          setNotice("");
        } else {
          setStops([]);
          setLegs([]);
          if (!home) {
            setNotice(
              "Add your home address to your staff profile and the Home bookends will fill themselves in — you can still add stops by hand below.",
            );
          }
        }
        setLoadedIds([]);
      }
      setDirty(false);
      setDayLoaded(true);
    },
    [user, homeStop, officeStop],
  );

  // Initial data: agencies + patients, then the day.
  useEffect(() => {
    if (!apiConnected) return;
    let cancelled = false;
    (async () => {
      try {
        const ags = await fetchAgencies(user);
        if (cancelled) return;
        const active = ags.filter((a) => a.active);
        setAgencies(active);
        const primary = active.find((a) => a.is_primary) ?? active[0] ?? null;
        const initialAgency = primary ? primary.id : null;
        setAgencyId(initialAgency);
        setRepAgency(initialAgency);
        await loadDay(todayStr(), initialAgency, active);
      } catch (err) {
        if (!cancelled) setError(errText(err, "Could not load mileage data."));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiConnected, user]);

  const switchDay = async (nextDate: string, nextAgency: number | null) => {
    if (dirty) {
      setError("Save this day first — switching would drop unsaved changes.");
      return;
    }
    setDate(nextDate);
    setAgencyId(nextAgency);
    setDayLoaded(false);
    try {
      await loadDay(nextDate, nextAgency, agencies ?? []);
    } catch (err) {
      setError(errText(err, "Could not load that day."));
      setDayLoaded(true);
    }
  };

  // ---------- routing ----------
  // Route any leg whose endpoints both have coordinates and
  // whose coordinate signature has not been routed yet.
  useEffect(() => {
    if (!dayLoaded) return;
    legs.forEach((leg, i) => {
      const from = stops[i];
      const to = stops[i + 1];
      if (!from || !to) return;
      if (from.lat === null || from.lng === null || to.lat === null || to.lng === null) return;
      const sig = `${from.lat},${from.lng}->${to.lat},${to.lng}`;
      if (leg.routed_sig === sig || leg.routing) return;
      setLegs((prev) =>
        prev.map((l, j) => (j === i ? { ...l, routing: true, route_failed: false } : l)),
      );
      routeMiles(user, { lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng })
        .then(({ miles_toll, miles_no_toll }) => {
          setLegs((prev) =>
            prev.map((l, j) => {
              if (j !== i) return l;
              const used = l.used_tollway
                ? (miles_toll ?? miles_no_toll)
                : (miles_no_toll ?? miles_toll);
              return {
                ...l,
                miles_toll,
                miles_no_toll,
                miles: used !== null ? String(used) : l.miles,
                routed_sig: sig,
                routing: false,
              };
            }),
          );
          setDirty(true);
        })
        .catch(() => {
          setLegs((prev) =>
            prev.map((l, j) =>
              j === i ? { ...l, routed_sig: sig, routing: false, route_failed: true } : l,
            ),
          );
        });
    });
  }, [stops, legs, dayLoaded, user]);

  // ---------- chain editing ----------

  const updateStop = (key: string, stop: Stop) => {
    setStops((prev) => prev.map((s) => (s.key === key ? { ...stop, key } : s)));
    setDirty(true);
    setEditingKey(null);
  };

  const addStop = () => {
    const blank: Stop = {
      key: nextKey(),
      kind: "custom",
      label: "",
      address: "",
      lat: null,
      lng: null,
      patient_id: null,
    };
    // Keep the bookend template [home, office, ...stops...,
    // office, home]: a bare [home, office, home] day splits
    // its single office into start + return stops for the
    // first middle stop; later stops insert before the
    // closing office. Non-template chains just append.
    let next: Stop[];
    const lastStop = stops[stops.length - 1];
    const secondLast = stops[stops.length - 2];
    if (
      stops.length === 3 &&
      stops[0].kind === "home" &&
      secondLast?.kind === "office" &&
      lastStop?.kind === "home"
    ) {
      const officeCopy: Stop = { ...secondLast, key: nextKey() };
      next = [stops[0], secondLast, blank, officeCopy, lastStop];
    } else if (
      stops.length > 3 &&
      secondLast?.kind === "office" &&
      lastStop?.kind === "home"
    ) {
      next = [...stops.slice(0, stops.length - 2), blank, secondLast, lastStop];
    } else {
      next = [...stops, blank];
    }
    setLegs((prev) => {
      const target = Math.max(0, next.length - 1);
      if (prev.length >= target) return prev;
      return [...prev, ...Array.from({ length: target - prev.length }, blankLeg)];
    });
    setStops(next);
    setDirty(true);
    setEditingKey(blank.key);
  };

  const removeStop = (key: string) => {
    const idx = stops.findIndex((s) => s.key === key);
    if (idx < 0) return;
    setStops((prev) => prev.filter((s) => s.key !== key));
    setLegs((prev) => {
      // Removing a stop merges its two adjacent legs into the
      // previous one; the merged leg re-routes from its new
      // endpoints. Removing an end stop drops its only leg.
      if (idx === 0) return prev.slice(1);
      if (idx === stops.length - 1) return prev.slice(0, -1);
      const next = [...prev];
      next.splice(idx, 1);
      next[idx - 1] = { ...next[idx - 1], routed_sig: "", miles_toll: null, miles_no_toll: null };
      return next;
    });
    setDirty(true);
  };

  const updateLeg = (i: number, patch: Partial<LegState>) => {
    setLegs((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  const toggleTollway = (i: number, tollway: boolean) => {
    const leg = legs[i];
    const used = tollway
      ? (leg.miles_toll ?? leg.miles_no_toll)
      : (leg.miles_no_toll ?? leg.miles_toll);
    updateLeg(i, {
      used_tollway: tollway,
      miles: used !== null ? String(used) : leg.miles,
    });
  };

  // ---------- save ----------

  const saveDay = async () => {
    setBusy(true);
    setError("");
    try {
      const rateNum = Number(rate);
      const savedIds: number[] = [];
      for (let i = 0; i < legs.length; i += 1) {
        const leg = legs[i];
        const from = stops[i];
        const to = stops[i + 1];
        const kind = legKind(from, to, leg.kind_override);
        const input = {
          entry_date: date,
          seq: i,
          entry_kind: kind,
          start_label: from.label || null,
          start_address: from.address || null,
          end_label: to.label || null,
          end_address: to.address || null,
          start_lat: from.lat,
          start_lng: from.lng,
          end_lat: to.lat,
          end_lng: to.lng,
          patient_id: to.patient_id,
          agency_id: agencyId,
          miles_toll: leg.miles_toll,
          miles_no_toll: leg.miles_no_toll,
          used_tollway: leg.used_tollway,
          business_miles: Number(leg.miles) || 0,
          rate_per_mile: kind === "business" && rateNum > 0 ? rateNum : null,
        };
        const saved: MileageEntry = leg.saved_id
          ? await updateMileage(user, leg.saved_id, input)
          : await createMileage(user, input);
        savedIds.push(saved.id);
      }
      for (const id of loadedIds) {
        if (!savedIds.includes(id)) await deleteMileage(user, id);
      }
      localStorage.setItem("caretask-mileage-rate", rate);
      await loadDay(date, agencyId, agencies ?? []);
      setNotice("Day saved.");
    } catch (err) {
      setError(errText(err, "Could not save the day log."));
    } finally {
      setBusy(false);
    }
  };

  // ---------- report ----------

  const generateReport = async () => {
    setRepBusy(true);
    setError("");
    try {
      const range = repMode === "month" ? monthRange(repMonth) : { from: repFrom, to: repTo };
      const rep = await fetchMileageReport(user, {
        ...range,
        agency_id: repAgency,
      });
      setReport(rep);
    } catch (err) {
      setError(errText(err, "Could not generate the report."));
    } finally {
      setRepBusy(false);
    }
  };

  // ---------- render ----------

  if (!apiConnected) {
    return (
      <section>
        <div className="page-head">
          <h1>Mileage</h1>
        </div>
        <p className="exp-notice">
          The mileage log is stored in the CareTask database — it can't load
          while the API is unreachable.
        </p>
      </section>
    );
  }

  const rateNum = Number(rate) || 0;
  let billable = 0;
  let personal = 0;
  legs.forEach((leg, i) => {
    const kind = legKind(stops[i], stops[i + 1], leg.kind_override);
    const mi = Number(leg.miles) || 0;
    if (kind === "commute") personal += mi;
    else billable += mi;
  });

  return (
    <section>
      <div className="page-head">
        <h1>Mileage</h1>
        <p className="page-sub">
          Log the day's drive as a chain — home and office bookends are
          personal; the stops between them are billable.
        </p>
      </div>

      {error && <p className="exp-error">{error}</p>}
      {notice && <p className="exp-notice">{notice}</p>}

      <div className="mlg-controls card">
        <label>
          Date
          <input
            type="date"
            value={date}
            onChange={(e) => void switchDay(e.target.value, agencyId)}
          />
        </label>
        <label>
          Agency
          <select
            value={agencyId ?? ""}
            onChange={(e) =>
              void switchDay(date, e.target.value ? Number(e.target.value) : null)
            }
          >
            {(agencies ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Rate ($/mi)
          <input
            type="number"
            min="0"
            step="0.01"
            value={rate}
            onChange={(e) => {
              setRate(e.target.value);
              setDirty(true);
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void saveDay()}
          disabled={busy || !dayLoaded}
        >
          <Check size={16} /> {busy ? "Saving…" : "Save day log"}
        </button>
      </div>

      <div className="card mlg-chain">
        {!dayLoaded && <p className="mlg-empty">Loading the day…</p>}
        {dayLoaded && stops.length === 0 && (
          <p className="mlg-empty">
            No stops yet. Add your first stop below — pick a patient, tap
            Home or Office, or type any address.
          </p>
        )}
        {stops.map((stop, i) => (
          <div key={stop.key}>
            <StopRow
              stop={stop}
              patients={people}
              homeStop={homeStop}
              officeStop={agency ? () => officeStop(agency) : null}
              editing={editingKey === stop.key}
              onEdit={() => setEditingKey(stop.key)}
              onDone={(s) => updateStop(stop.key, s)}
              onCancel={() => setEditingKey(null)}
              onRemove={() => removeStop(stop.key)}
            />
            {i < legs.length && (
              <LegRow
                leg={legs[i]}
                kind={legKind(stop, stops[i + 1], legs[i].kind_override)}
                onToggle={(t) => toggleTollway(i, t)}
                onMiles={(v) => updateLeg(i, { miles: v })}
                onKind={(k) => updateLeg(i, { kind_override: k })}
              />
            )}
          </div>
        ))}
        <div className="mlg-addstop">
          <button type="button" className="btn" onClick={addStop}>
            <Plus size={16} /> Add a stop
          </button>
          <span className="mlg-hint">
            Pick a patient, tap Home/Office, or type any address — each new
            stop chains from the one before it.
          </span>
        </div>
      </div>

      <div className="mlg-totals">
        <div className="mlg-total mlg-total-hero">
          <span>Billable</span>
          <strong>{round2(billable)} mi</strong>
        </div>
        <div className="mlg-total">
          <span>Personal (fixed)</span>
          <strong>{round2(personal)} mi</strong>
        </div>
        <div className="mlg-total">
          <span>Driven</span>
          <strong>{round2(billable + personal)} mi</strong>
        </div>
        <div className="mlg-total">
          <span>Reimbursement</span>
          <strong>{money(Math.round(billable * rateNum * 100))}</strong>
        </div>
      </div>

      <div className="card mlg-report">
        <h2>Expense report</h2>
        <div className="mlg-controls">
          <label>
            Period
            <select
              value={repMode}
              onChange={(e) => setRepMode(e.target.value as "month" | "range")}
            >
              <option value="month">Month</option>
              <option value="range">Date range</option>
            </select>
          </label>
          {repMode === "month" ? (
            <label>
              Month
              <input
                type="month"
                value={repMonth}
                onChange={(e) => setRepMonth(e.target.value)}
              />
            </label>
          ) : (
            <>
              <label>
                From
                <input
                  type="date"
                  value={repFrom}
                  onChange={(e) => setRepFrom(e.target.value)}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={repTo}
                  onChange={(e) => setRepTo(e.target.value)}
                />
              </label>
            </>
          )}
          <label>
            Agency
            <select
              value={repAgency ?? ""}
              onChange={(e) =>
                setRepAgency(e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">All agencies</option>
              {(agencies ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void generateReport()}
            disabled={repBusy}
          >
            {repBusy ? "Generating…" : "Generate"}
          </button>
          {report && (
            <button type="button" className="btn" onClick={() => window.print()}>
              <Printer size={16} /> Print / PDF
            </button>
          )}
        </div>

        {report && (
          <div className="mlg-print">
            <h3>
              Mileage report — {prettyDate(report.from)} to {prettyDate(report.to)}
              {report.clinician_name ? ` · ${report.clinician_name}` : ""}
            </h3>
            {report.days.length === 0 && (
              <p className="mlg-empty">No mileage logged in this period.</p>
            )}
            {report.days.map((d) => (
              <div key={d.date} className="mlg-day">
                <div className="mlg-day-head">
                  <strong>{prettyDate(d.date)}</strong>
                  <span>
                    Billable {d.billable_miles} mi · Personal {d.personal_miles} mi ·{" "}
                    {money(d.amount_cents)}
                  </span>
                </div>
                {d.legs.map((l) => (
                  <div key={l.id} className="mlg-day-leg">
                    <span>
                      {l.start_label || l.start_address || "—"} →{" "}
                      {l.end_label || l.end_address || "—"}
                    </span>
                    <span>
                      {l.business_miles} mi
                      {l.entry_kind === "commute" ? " · personal" : ""}
                      {l.entry_kind === "business" && l.miles_no_toll !== null
                        ? l.used_tollway
                          ? " · tollway"
                          : " · back roads"
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {report.days.length > 0 && (
              <div className="mlg-day-head mlg-report-total">
                <strong>Totals</strong>
                <span>
                  Billable {report.total_billable_miles} mi · Personal{" "}
                  {report.total_personal_miles} mi · Driven{" "}
                  {report.total_driven_miles} mi ·{" "}
                  <strong>{money(report.total_amount_cents)}</strong>
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- stop row + editor ----------

function StopRow({
  stop,
  patients,
  homeStop,
  officeStop,
  editing,
  onEdit,
  onDone,
  onCancel,
  onRemove,
}: {
  stop: Stop;
  patients: PersonUnderCare[];
  homeStop: () => Promise<Stop | null>;
  officeStop: (() => Promise<Stop | null>) | null;
  editing: boolean;
  onEdit: () => void;
  onDone: (s: Stop) => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const kindLabel =
    stop.kind === "home"
      ? "Home"
      : stop.kind === "office"
        ? "Agency office"
        : stop.kind === "patient"
          ? "Patient"
          : "Stop";
  return (
    <div className="mlg-stop">
      <div className="mlg-stop-main">
        <span className="mlg-stop-kind">{kindLabel}</span>
        <strong>{stop.label || stop.address || "New stop"}</strong>
        {stop.label && stop.address && <span className="mlg-stop-addr">{stop.address}</span>}
        {!stop.label && !stop.address && (
          <span className="mlg-stop-addr">Tap Edit to set this stop.</span>
        )}
      </div>
      {!editing && (
        <div className="mlg-stop-actions">
          <button type="button" className="btn btn-small" onClick={onEdit}>
            <Pencil size={14} /> Edit
          </button>
          <button type="button" className="btn btn-small" onClick={onRemove} aria-label="Remove stop">
            <Trash2 size={14} />
          </button>
        </div>
      )}
      {editing && (
        <StopEditor
          stop={stop}
          patients={patients}
          homeStop={homeStop}
          officeStop={officeStop}
          onDone={onDone}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

function StopEditor({
  stop,
  patients,
  homeStop,
  officeStop,
  onDone,
  onCancel,
}: {
  stop: Stop;
  patients: PersonUnderCare[];
  homeStop: () => Promise<Stop | null>;
  officeStop: (() => Promise<Stop | null>) | null;
  onDone: (s: Stop) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Stop>(stop);
  const [addrText, setAddrText] = useState(stop.address);
  const [patientQuery, setPatientQuery] = useState("");
  const [pickError, setPickError] = useState("");

  const matches = patientQuery.trim()
    ? patients
        .filter((p) =>
          `${p.lname ?? ""} ${p.fname ?? ""} ${p.name}`
            .toLowerCase()
            .includes(patientQuery.toLowerCase()),
        )
        .slice(0, 6)
    : [];

  const pickPatient = (p: PersonUnderCare) => {
    const address = joinAddress(p.street, p.city, p.state, p.postalCode);
    setDraft({
      ...draft,
      kind: "patient",
      label: p.lname && p.fname ? `${p.lname}, ${p.fname}` : p.name,
      address,
      lat: p.latitude ?? null,
      lng: p.longitude ?? null,
      patient_id: p.id,
    });
    setAddrText(address);
    setPatientQuery("");
  };

  const pickKnown = async (which: "home" | "office") => {
    setPickError("");
    const s = which === "home" ? await homeStop() : officeStop ? await officeStop() : null;
    if (!s) {
      setPickError(
        which === "home"
          ? "No home address on your staff profile yet."
          : "That agency has no address on file.",
      );
      return;
    }
    setDraft({ ...s, key: draft.key });
    setAddrText(s.address);
  };

  return (
    <div className="mlg-editor">
      <div className="mlg-chips">
        <button type="button" className="btn btn-small" onClick={() => void pickKnown("home")}>
          <Home size={14} /> Home
        </button>
        <button type="button" className="btn btn-small" onClick={() => void pickKnown("office")}>
          <Building2 size={14} /> Office
        </button>
        <span className="mlg-hint">…or find a patient, or type any address:</span>
      </div>
      {pickError && <p className="exp-error">{pickError}</p>}
      <input
        type="text"
        placeholder="Search patients by name…"
        value={patientQuery}
        onChange={(e) => setPatientQuery(e.target.value)}
      />
      {matches.length > 0 && (
        <div className="mlg-patient-results">
          {matches.map((p) => (
            <button key={p.id} type="button" onClick={() => pickPatient(p)}>
              <strong>
                {p.lname && p.fname ? `${p.lname}, ${p.fname}` : p.name}
              </strong>
              <span>{joinAddress(p.street, p.city, p.state, p.postalCode)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="form-field">
        <span>Address</span>
        <AddressAutocomplete
          value={addrText}
          onChange={(v) => {
            setAddrText(v);
            // Typing over a picked patient turns the stop into
            // a plain address stop; Home/Office keep their
            // labels (their profile address is being edited).
            setDraft((d) => ({
              ...d,
              kind: d.kind === "patient" ? "custom" : d.kind,
              address: v,
              lat: null,
              lng: null,
              patient_id: null,
              label: d.kind === "patient" ? "" : d.label,
            }));
          }}
          onSelectAddress={(a: SuggestedAddress) => {
            const address = suggestedToAddress(a);
            setAddrText(address);
            setDraft((d) => ({
              ...d,
              kind: d.kind === "patient" ? "custom" : d.kind,
              address,
              lat: a.latitude,
              lng: a.longitude,
              patient_id: null,
              label: d.kind === "patient" ? "" : d.label,
            }));
          }}
        />
      </div>
      {(draft.label || draft.address) && (
        <p className="mlg-hint">
          <MapPin size={13} /> {draft.label ? `${draft.label} — ` : ""}
          {draft.address}
          {draft.lat === null ? " (no coordinates — routing unavailable, type the miles)" : ""}
        </p>
      )}
      <div className="mlg-editor-actions">
        <button type="button" className="btn btn-primary" onClick={() => onDone(draft)}>
          <Check size={15} /> Done
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          <X size={15} /> Cancel
        </button>
      </div>
    </div>
  );
}

// ---------- leg row ----------

function LegRow({
  leg,
  kind,
  onToggle,
  onMiles,
  onKind,
}: {
  leg: LegState;
  kind: "business" | "commute";
  onToggle: (tollway: boolean) => void;
  onMiles: (v: string) => void;
  onKind: (k: "business" | "commute") => void;
}) {
  return (
    <div className={`mlg-leg${kind === "commute" ? " mlg-leg-fixed" : ""}`}>
      <span className="mlg-arrow">↓</span>
      <div className="mlg-leg-miles">
        <input
          type="number"
          min="0"
          step="0.1"
          value={leg.miles}
          placeholder="0.0"
          onChange={(e) => onMiles(e.target.value)}
          aria-label="Leg miles"
        />
        <span>mi</span>
      </div>
      {kind === "business" ? (
        <div className="mlg-seg" role="group" aria-label="Route used">
          <button
            type="button"
            className={leg.used_tollway ? "on" : ""}
            onClick={() => onToggle(true)}
          >
            Tollway
          </button>
          <button
            type="button"
            className={!leg.used_tollway ? "on alt" : ""}
            onClick={() => onToggle(false)}
          >
            Back roads
          </button>
        </div>
      ) : (
        <span className="mlg-hint">Fixed — set by the addresses</span>
      )}
      <span className="mlg-leg-note">
        {leg.routing
          ? "Routing…"
          : leg.route_failed
            ? "Routing unavailable — type the miles."
            : leg.miles_toll !== null || leg.miles_no_toll !== null
              ? `Tollway ${leg.miles_toll ?? "—"} · Back roads ${leg.miles_no_toll ?? "—"}`
              : ""}
      </span>
      <button
        type="button"
        className={`mlg-badge ${kind === "commute" ? "mlg-badge-pers" : "mlg-badge-bill"}`}
        onClick={() => onKind(kind === "commute" ? "business" : "commute")}
        title="Tap to switch billable / personal"
      >
        {kind === "commute" ? "Personal" : "Billable"}
      </button>
    </div>
  );
}
