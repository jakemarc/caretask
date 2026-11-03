import { useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import {
  createAppointment,
  deleteAppointment,
  isRoleRejection,
  listAppointmentCategories,
  listAppointmentStatuses,
  listAppointments,
  setAppointmentStatus,
  updateAppointment,
  type ApiAppointment,
  type AppointmentCategory,
  type AppointmentStatusInfo,
} from "../lib/patientApi";
import { isManagerRole, useMyStaff } from "../lib/useMyRole";
import DayScheduleMap from "./DayScheduleMap";
import type { MapPatientLike } from "../lib/geo";

// Google Calendar-style appointment view backed by the CareTask
// appointments API (OpenEMR-correlated model: categories carry the
// color + default duration, provider is a staff member, statuses
// come from the API's flow list). Month / Week / Agenda views,
// click-a-day booking, one-click status changes (flow board),
// ungated edits, and a manager/admin role gate on delete — the
// same rules as patients (the manager PIN was retired 2026-11-02).

type CalView = "month" | "week" | "3day" | "agenda" | "map";

interface Props {
  user: User;
  apiConnected: boolean;
  patients: MapPatientLike[];
  clinicians: { id: string; name: string }[];
  // The signed-in clinician's staff id — the new-appointment
  // form defaults Provider to them (Jake, 2026-11-02).
  defaultProviderId?: string;
  // One-shot "open a fresh booking form" intent from the
  // sidebar Appointment button; cleared via onIntentHandled
  // once the form opens (Jake, 2026-11-02).
  intent?: "create" | null;
  onIntentHandled?: () => void;
  onOpenPatient: (id: string) => void;
}

const DAY_MS = 86400000;

// Jake's appointment statuses (2026-11-02): exactly three,
// color-coded — Scheduled yellow, Completed green, Missed red.
export const APPOINTMENT_STATUSES = [
  { code: "scheduled", label: "Scheduled", tone: "amber" },
  { code: "completed", label: "Completed", tone: "green" },
  { code: "missed", label: "Missed", tone: "red" },
] as const;

const LEGACY_STATUS_GROUP: Record<string, string> = {
  booked: "scheduled",
  confirmed: "scheduled",
  arrived: "scheduled",
  in_room: "scheduled",
  checked_out: "completed",
  no_show: "missed",
};

export function statusGroup(code: string): string {
  return LEGACY_STATUS_GROUP[code] ?? code;
}

export function statusMeta(
  code: string,
): (typeof APPOINTMENT_STATUSES)[number] | undefined {
  return APPOINTMENT_STATUSES.find((s) => s.code === statusGroup(code));
}

// Compact day-row text for phone widths (Jake, 2026-11-02):
// no status, no provider; the visit name abbreviated; the
// patient shown last-name-first with the first name as an
// initial, and a long last name cut to its first 4 letters.
const CATEGORY_SHORT: Record<string, string> = {
  // Jake's own codes (2026-11-02).
  "Initial Evaluation": "I.E.",
  "Start of Care": "SOC",
  "Resumption of Care": "ROC",
  Reassessment: "RE",
  "Discipline Discharge": "DDC",
  "Admin Discharge": "ADC",
  "OASIS Discharge": "ODC",
};

export function shortCategoryName(name: string): string {
  const hit = CATEGORY_SHORT[name];
  if (hit) return hit;
  if (name.length <= 12) return name;
  return name
    .split(" ")
    .map((w, i) => (i === 0 ? w : w.slice(0, 4)))
    .join(" ");
}

export function compactPatientName(
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const first = parts[0];
  const last = parts[parts.length - 1];
  const lastShort = last.length > 8 ? `${last.slice(0, 4)}.` : last;
  return `${lastShort}, ${first.charAt(0)}.`;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
function fmtRange(a: ApiAppointment): string {
  return `${fmtTime(a.starts_at)} – ${fmtTime(a.ends_at)}`;
}
function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full;
  return `${parts[parts.length - 1]}, ${parts[0][0]}.`;
}
function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function toTimeInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function CalendarView({
  user,
  apiConnected,
  patients,
  clinicians,
  defaultProviderId,
  intent,
  onIntentHandled,
  onOpenPatient,
}: Props) {
  const me = useMyStaff(user);
  const isManager = isManagerRole(me);
  // Default view is the daily schedule (agenda), anchored on
  // today (Jake, 2026-10-31). The agenda range below is today
  // forward 31 days, so today's visits are always fetched.
  const [view, setView] = useState<CalView>("agenda");
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [appts, setAppts] = useState<ApiAppointment[]>([]);
  const [cats, setCats] = useState<AppointmentCategory[]>([]);
  const [statuses, setStatuses] = useState<AppointmentStatusInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedDay, setSelectedDay] = useState<string>(() =>
    dayKey(new Date()),
  );
  // Day shown by the Map view (independent of the month/week anchor).
  const [mapDay, setMapDay] = useState<Date>(() => startOfDay(new Date()));
  // Agency filter (2026-11-02): appointments inherit their agency
  // through the patient. "all" | "none" | an agency key.
  const [agencyFilter, setAgencyFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Form state (null = closed). editing = the appointment being
  // edited, or null for a new one.
  const [editing, setEditing] = useState<ApiAppointment | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [fPatient, setFPatient] = useState("");
  const [fPatientQuery, setFPatientQuery] = useState("");
  const [fPatientOpen, setFPatientOpen] = useState(false);
  const [fProvider, setFProvider] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fTitle, setFTitle] = useState("");
  const [fDate, setFDate] = useState("");
  const [fTime, setFTime] = useState("09:00");
  const [fDuration, setFDuration] = useState(45);
  const [fRoom, setFRoom] = useState("");
  const [fNotes, setFNotes] = useState("");
  const [fStatus, setFStatus] = useState("scheduled");
  const [saving, setSaving] = useState(false);

  // Delete is role-gated (manager/admin): managers get a
  // two-step confirm in place of the button.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    setConfirmingDelete(false);
  }, [selectedId]);

  const range = useMemo(() => {
    if (view === "month") {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const gridStart = addDays(first, -first.getDay());
      return { from: gridStart, to: addDays(gridStart, 42) };
    }
    if (view === "week") {
      const start = addDays(anchor, -anchor.getDay());
      return { from: startOfDay(start), to: addDays(startOfDay(start), 7) };
    }
    if (view === "3day") {
      const from = startOfDay(anchor);
      return { from, to: addDays(from, 3) };
    }
    if (view === "map") {
      const from = startOfDay(mapDay);
      return { from, to: addDays(from, 1) };
    }
    const from = startOfDay(new Date());
    return { from, to: addDays(from, 31) };
  }, [view, anchor, mapDay]);

  // Reference lists once; appointments per visible range.
  useEffect(() => {
    if (!apiConnected) return;
    let live = true;
    (async () => {
      try {
        const [c, s] = await Promise.all([
          listAppointmentCategories(user),
          listAppointmentStatuses(user),
        ]);
        if (live) {
          setCats(c);
          setStatuses(s);
        }
      } catch {
        /* the appointments fetch below surfaces connection errors */
      }
    })();
    return () => {
      live = false;
    };
  }, [apiConnected, user]);

  useEffect(() => {
    if (!apiConnected) return;
    let live = true;
    setLoading(true);
    (async () => {
      try {
        const rows = await listAppointments(
          user,
          range.from.toISOString(),
          range.to.toISOString(),
        );
        if (live) setAppts(rows);
      } catch {
        if (live) setNotice("Couldn't load appointments from the API.");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [apiConnected, user, range, refreshTick]);

  // patient_id → agency {key, name}. The key prefers the linked
  // directory id and falls back to the free-text name, matching
  // how patients store agency (agency_id XOR agency_name_text).
  const patientAgency = useMemo(() => {
    const map = new Map<string, { key: string; name: string }>();
    for (const p of patients) {
      if (p.agencyId != null)
        map.set(p.id, {
          key: `id:${p.agencyId}`,
          name: p.agencyName ?? `Agency #${p.agencyId}`,
        });
      else if (p.agencyName)
        map.set(p.id, { key: `tx:${p.agencyName}`, name: p.agencyName });
    }
    return map;
  }, [patients]);

  const agencyOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of patientAgency.values()) {
      if (!seen.has(a.key)) seen.set(a.key, a.name);
    }
    return [...seen.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((x, y) => x.label.localeCompare(y.label));
  }, [patientAgency]);

  const agencyNameFor = (a: ApiAppointment): string | null =>
    a.patient_id ? (patientAgency.get(a.patient_id)?.name ?? null) : null;

  // Patient picker choices (Jake, 2026-11-02): ACTIVE patients
  // only, matched against the typed text. When editing, the
  // appointment's current patient stays in the list even if they
  // have since gone on hold / been discharged, so an edit never
  // silently loses its patient (marked "not active").
  const patientChoices = useMemo(() => {
    const q = fPatientQuery.trim().toLowerCase();
    const active = patients.filter(
      (p) => (p.patientStatus ?? "active") === "active",
    );
    const pool =
      fPatient && !active.some((p) => p.id === fPatient)
        ? [...active, ...patients.filter((p) => p.id === fPatient)]
        : active;
    return pool
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [patients, fPatient, fPatientQuery]);

  // Blocks (no patient) always show; patient appointments show
  // when their agency matches the filter.
  const visibleAppts = useMemo(() => {
    if (agencyFilter === "all") return appts;
    return appts.filter(
      (a) =>
        !a.patient_id ||
        (patientAgency.get(a.patient_id)?.key ?? "none") === agencyFilter,
    );
  }, [appts, agencyFilter, patientAgency]);

  const byDay = useMemo(() => {
    const map = new Map<string, ApiAppointment[]>();
    for (const a of visibleAppts) {
      const k = dayKey(new Date(a.starts_at));
      const arr = map.get(k) ?? [];
      arr.push(a);
      map.set(k, arr);
    }
    return map;
  }, [visibleAppts]);

  const selected = appts.find((a) => a.id === selectedId) ?? null;
  // Jake's three statuses (2026-11-02), color-coded: Scheduled
  // yellow, Completed green, Missed red. Legacy codes from the
  // old flow board group into them for display; the API
  // migration rewrites stored rows to the three, so the
  // grouping is a fallback for anything not yet migrated.
  const statusLabel = (code: string) =>
    statusMeta(code)?.label ??
    statuses.find((s) => s.code === code)?.label ??
    code;
  const catById = (id: string) => cats.find((c) => c.id === id);

  function step(dir: number) {
    if (view === "month")
      setAnchor(
        (a) => new Date(a.getFullYear(), a.getMonth() + dir, 1),
      );
    else if (view === "map") setMapDay((d) => addDays(d, dir));
    else if (view === "week") setAnchor((a) => addDays(a, dir * 7));
    else if (view === "3day") setAnchor((a) => addDays(a, dir * 3));
    else setAnchor((a) => addDays(a, dir * 7));
  }

  const title = useMemo(() => {
    if (view === "month")
      return anchor.toLocaleDateString([], {
        month: "long",
        year: "numeric",
      });
    if (view === "week") {
      const start = addDays(anchor, -anchor.getDay());
      const end = addDays(start, 6);
      const sameMonth = start.getMonth() === end.getMonth();
      return sameMonth
        ? `${start.toLocaleDateString([], { month: "long" })} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`
        : `${start.toLocaleDateString([], { month: "short", day: "numeric" })} – ${end.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
    }
    if (view === "3day") {
      const start = startOfDay(anchor);
      const end = addDays(start, 2);
      const sameMonth = start.getMonth() === end.getMonth();
      return sameMonth
        ? `${start.toLocaleDateString([], { month: "long" })} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`
        : `${start.toLocaleDateString([], { month: "short", day: "numeric" })} – ${end.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
    }
    if (view === "map")
      return mapDay.toLocaleDateString([], {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    return "Next 30 days";
  }, [view, anchor, mapDay]);

  // Sidebar Appointment button intent: open a fresh booking
  // form once the categories have loaded. The start time is
  // the next whole hour inside working hours; after 5 PM it
  // lands tomorrow at 9.
  useEffect(() => {
    if (intent !== "create" || !apiConnected || cats.length === 0)
      return;
    const now = new Date();
    const nextHour = now.getHours() + 1;
    if (nextHour <= 17) {
      setAnchor(startOfDay(now));
      setSelectedDay(dayKey(now));
      openCreate(now, Math.max(8, nextHour));
    } else {
      const tmr = addDays(startOfDay(now), 1);
      setAnchor(tmr);
      setSelectedDay(dayKey(tmr));
      openCreate(tmr, 9);
    }
    onIntentHandled?.();
    // openCreate is re-created per render; cats + intent are
    // the meaningful triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, apiConnected, cats]);

  function openCreate(day: Date, hour = 9) {
    // Jake's defaults (2026-11-02): the category starts on
    // Revisit, and the provider starts on the signed-in
    // clinician (when they are a pickable provider at all).
    const firstCat =
      cats.find((c) => c.name.trim().toLowerCase() === "revisit") ??
      cats.find((c) => c.cattype === "appointment") ??
      cats[0];
    setEditing(null);
    setFPatient("");
    setFPatientQuery("");
    setFPatientOpen(false);
    setFProvider(
      defaultProviderId &&
        clinicians.some((c) => c.id === defaultProviderId)
        ? defaultProviderId
        : "",
    );
    setFCategory(firstCat ? String(firstCat.id) : "");
    setFTitle("");
    const d = startOfDay(day);
    d.setHours(hour, 0, 0, 0);
    setFDate(toDateInput(d));
    setFTime(toTimeInput(d));
    setFDuration(firstCat?.default_duration_min ?? 45);
    setFRoom("");
    setFNotes("");
    setFStatus("scheduled");
    setFormOpen(true);
  }

  function openEdit(a: ApiAppointment) {
    setEditing(a);
    setFPatient(a.patient_id ?? "");
    setFPatientQuery(a.patient_name ?? "");
    setFPatientOpen(false);
    setFProvider(a.provider_id ?? "");
    setFCategory(String(a.category_id));
    setFTitle(a.title);
    const s = new Date(a.starts_at);
    setFDate(toDateInput(s));
    setFTime(toTimeInput(s));
    setFDuration(
      Math.max(
        15,
        Math.round(
          (new Date(a.ends_at).getTime() - s.getTime()) / 60000,
        ),
      ),
    );
    setFRoom(a.room ?? "");
    setFNotes(a.notes ?? "");
    setFStatus(statusGroup(a.status));
    setFormOpen(true);
  }

  function buildInput() {
    const cat = catById(fCategory);
    const start = new Date(`${fDate}T${fTime}`);
    const end = new Date(start.getTime() + fDuration * 60000);
    return {
      patient_id:
        cat?.cattype === "appointment" ? fPatient || null : null,
      provider_id: fProvider || null,
      category_id: fCategory,
      title: fTitle.trim() || undefined,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      room: fRoom.trim() || null,
      notes: fNotes.trim() || null,
      ...(editing ? { status: fStatus } : {}),
    };
  }

  async function doSave() {
    setSaving(true);
    setNotice("");
    try {
      if (editing) {
        const updated = await updateAppointment(
          user,
          editing.id,
          buildInput(),
        );
        setAppts((prev) =>
          prev.map((a) => (a.id === updated.id ? updated : a)),
        );
        setSelectedId(updated.id);
      } else {
        await createAppointment(user, buildInput());
        setRefreshTick((t) => t + 1);
      }
      setFormOpen(false);
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "Couldn't save the appointment.",
      );
    } finally {
      setSaving(false);
    }
  }

  function submitForm() {
    const cat = catById(fCategory);
    if (!fCategory) return setNotice("Pick a category.");
    if (cat?.cattype === "appointment" && !fPatient)
      return setNotice("Pick a patient for this category.");
    if (!fDate || !fTime) return setNotice("Pick a date and start time.");
    void doSave();
  }

  async function doDelete() {
    if (!selected) return;
    try {
      await deleteAppointment(user, selected.id);
      setAppts((prev) => prev.filter((a) => a.id !== selected.id));
      setSelectedId(null);
      setConfirmingDelete(false);
    } catch (err) {
      setNotice(
        isRoleRejection(err)
          ? "Deleting an appointment needs a manager or admin role."
          : "Couldn't delete the appointment.",
      );
    }
  }

  async function changeStatus(a: ApiAppointment, status: string) {
    try {
      const updated = await setAppointmentStatus(user, a.id, status);
      setAppts((prev) =>
        prev.map((x) => (x.id === updated.id ? updated : x)),
      );
    } catch {
      setNotice("Couldn't change the status.");
    }
  }

  const chip = (a: ApiAppointment) => (
    <button
      key={a.id}
      className={`cal-chip${a.status === "cancelled" || a.status === "no_show" || a.status === "missed" ? " cal-chip-muted" : ""}`}
      style={{ borderLeftColor: a.category_color }}
      onClick={(e) => {
        e.stopPropagation();
        setSelectedId(a.id);
        setSelectedDay(dayKey(new Date(a.starts_at)));
      }}
      title={`${a.patient_name ?? a.title} · ${fmtRange(a)}`}
    >
      <span className="cal-chip-time">{fmtTime(a.starts_at)}</span>{" "}
      {a.patient_name ? shortName(a.patient_name) : a.title}
      {agencyNameFor(a) && (
        <span className="cal-chip-agency"> · {agencyNameFor(a)}</span>
      )}
    </button>
  );

  const monthCells = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const gridStart = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [anchor]);

  const weekDays = useMemo(() => {
    const start = addDays(anchor, -anchor.getDay());
    return Array.from({ length: 7 }, (_, i) => addDays(startOfDay(start), i));
  }, [anchor]);

  // The 3 Day view (Jake, 2026-11-02): three day columns
  // starting at the anchor day, same column layout as Week.
  const threeDays = useMemo(
    () =>
      Array.from({ length: 3 }, (_, i) => addDays(startOfDay(anchor), i)),
    [anchor],
  );

  const agendaDays = useMemo(() => {
    const days: { day: Date; items: ApiAppointment[] }[] = [];
    const sorted = [...visibleAppts].sort(
      (x, y) => +new Date(x.starts_at) - +new Date(y.starts_at),
    );
    for (const a of sorted) {
      const k = dayKey(new Date(a.starts_at));
      const last = days[days.length - 1];
      if (last && dayKey(last.day) === k) last.items.push(a);
      else days.push({ day: new Date(a.starts_at), items: [a] });
    }
    return days;
  }, [visibleAppts]);

  // Month-view legend (mobile markers): the visit types present
  // in the current filtered set, with their colors.
  const monthLegend = useMemo(() => {
    const seen = new Map<string, { name: string; color: string }>();
    for (const a of visibleAppts) {
      if (!seen.has(a.category_id)) {
        seen.set(a.category_id, {
          name: a.category_name,
          color: a.category_color,
        });
      }
    }
    return [...seen.values()].sort((x, y) => x.name.localeCompare(y.name));
  }, [visibleAppts]);

  const dayList = (day: Date) => {
    const items = (byDay.get(dayKey(day)) ?? []).sort(
      (x, y) => +new Date(x.starts_at) - +new Date(y.starts_at),
    );
    return (
      <div className="cal-daylist">
        <h3>
          {day.toLocaleDateString([], {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </h3>
        {items.length === 0 && (
          <p className="section-note">Nothing scheduled.</p>
        )}
        {items.map((a) => (
          <button
            key={a.id}
            className="cal-day-row"
            style={{ borderLeftColor: a.category_color }}
            onClick={() => setSelectedId(a.id)}
          >
            <span className="cal-day-time">{fmtRange(a)}</span>
            <span className="cal-day-full">
              <strong>{a.patient_name ?? a.title}</strong>
              <span className="card-meta">
                {" "}
                · {a.category_name}
                {a.provider_name ? ` · ${a.provider_name}` : ""}
                {agencyNameFor(a) ? ` · ${agencyNameFor(a)}` : ""} ·{" "}
                <span className={`cal-status cal-status-${statusMeta(a.status)?.tone ?? "gray"}`}>{statusLabel(a.status)}</span>
              </span>
            </span>
            <span className="cal-day-compact">
              <strong>{compactPatientName(a.patient_name) ?? a.title}</strong>
              <span className="card-meta">
                {" "}
                · {shortCategoryName(a.category_name)}
                {agencyNameFor(a) ? ` · ${agencyNameFor(a)}` : ""}
              </span>
            </span>
          </button>
        ))}
        <button
          className="btn"
          onClick={() => openCreate(day)}
        >
          + New appointment this day
        </button>
      </div>
    );
  };

  return (
    <section>
      <h1>Calendar</h1>
      {!apiConnected && (
        <article className="card">
          <strong>Calendar needs the patient API connection.</strong>
          <p>
            Appointments are stored in the CareTask database (not in
            this browser), so the calendar can't load or save while
            the API is unreachable.
          </p>
        </article>
      )}
      {apiConnected && (
        <>
          <div className="cal-toolbar">
            <div className="cal-nav">
              <button className="btn" onClick={() => step(-1)} aria-label="Previous">
                ‹
              </button>
              <button
                className="btn"
                onClick={() => {
                  setAnchor(startOfDay(new Date()));
                  setSelectedDay(dayKey(new Date()));
                }}
              >
                Today
              </button>
              <button className="btn" onClick={() => step(1)} aria-label="Next">
                ›
              </button>
              <strong className="cal-title">{title}</strong>
              {loading && <span className="card-meta">Loading…</span>}
            </div>
            <div className="cal-nav">
              {(
                [
                  ["agenda", "Day"],
                  ["3day", "3 Day"],
                  ["week", "Week"],
                  ["month", "Month"],
                  ["map", "Map"],
                ] as [CalView, string][]
              ).map(([v, label]) => (
                <button
                  key={v}
                  className={view === v ? "btn btn-primary" : "btn"}
                  onClick={() => setView(v)}
                >
                  {label}
                </button>
              ))}
              {agencyOptions.length > 0 && (
                <select
                  className="cal-agency-filter"
                  value={agencyFilter}
                  onChange={(e) => setAgencyFilter(e.target.value)}
                  aria-label="Filter appointments by agency"
                  title="Show appointments for one agency"
                >
                  <option value="all">All agencies</option>
                  {agencyOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                  <option value="none">No agency</option>
                </select>
              )}
              <button
                className="btn btn-primary"
                onClick={() => openCreate(anchor)}
              >
                + New appointment
              </button>
            </div>
          </div>

          {notice && <p className="pin-error">{notice}</p>}

          {view === "month" && (
            <>
              <div className="cal-grid cal-month">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                  (d) => (
                    <div key={d} className="cal-dow">
                      {d}
                    </div>
                  ),
                )}
                {monthCells.map((day) => {
                  const items = (byDay.get(dayKey(day)) ?? []).sort(
                    (x, y) =>
                      +new Date(x.starts_at) - +new Date(y.starts_at),
                  );
                  const isToday = dayKey(day) === dayKey(new Date());
                  const inMonth = day.getMonth() === anchor.getMonth();
                  return (
                    <div
                      key={dayKey(day)}
                      className={`cal-cell${inMonth ? "" : " cal-out"}${isToday ? " cal-today" : ""}${selectedDay === dayKey(day) ? " cal-selected" : ""}`}
                      onClick={() => setSelectedDay(dayKey(day))}
                      onDoubleClick={() => openCreate(day)}
                    >
                      <span className="cal-date">{day.getDate()}</span>
                      <span className="cal-cell-chips">
                        {items.slice(0, 3).map(chip)}
                        {items.length > 3 && (
                          <span className="cal-more">
                            +{items.length - 3} more
                          </span>
                        )}
                      </span>
                      <span className="cal-month-markers" aria-hidden="true">
                        {items.slice(0, 3).map((a) => (
                          <span
                            key={a.id}
                            className="cal-marker"
                            style={{ background: a.category_color }}
                          />
                        ))}
                        {items.length > 3 && (
                          <span className="cal-marker-more">
                            +{items.length - 3}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              {monthLegend.length > 0 && (
                <div className="cal-legend" aria-label="Appointment type colors">
                  {monthLegend.map((c) => (
                    <span key={c.name} className="cal-legend-item">
                      <span
                        className="cal-legend-dot"
                        style={{ background: c.color }}
                      />
                      {c.name}
                    </span>
                  ))}
                </div>
              )}
              {dayList(
                monthCells.find((d) => dayKey(d) === selectedDay) ??
                  new Date(),
              )}
            </>
          )}

          {(view === "week" || view === "3day") && (
            <div
              className={view === "3day" ? "cal-week cal-week-3" : "cal-week"}
            >
              {(view === "week" ? weekDays : threeDays).map((day) => {
                const items = (byDay.get(dayKey(day)) ?? []).sort(
                  (x, y) =>
                    +new Date(x.starts_at) - +new Date(y.starts_at),
                );
                return (
                  <div key={dayKey(day)} className="cal-week-day">
                    <h3>
                      {day.toLocaleDateString([], { weekday: "short" })}{" "}
                      <span
                        className={
                          dayKey(day) === dayKey(new Date())
                            ? "cal-today-num"
                            : ""
                        }
                      >
                        {day.getDate()}
                      </span>
                    </h3>
                    {items.map((a) => (
                      <button
                        key={a.id}
                        className="cal-week-block"
                        style={{
                          background: `${a.category_color}1f`,
                          borderLeftColor: a.category_color,
                        }}
                        onClick={() => setSelectedId(a.id)}
                      >
                        <strong>{fmtRange(a)}</strong>
                        <span>
                          {a.patient_name ?? a.title}
                        </span>
                        <span className="card-meta">
                          {a.category_name}
                          {agencyNameFor(a) ? ` · ${agencyNameFor(a)}` : ""}
                        </span>
                      </button>
                    ))}
                    <button
                      className="cal-add-slot"
                      onClick={() => openCreate(day)}
                    >
                      +
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {view === "agenda" && (
            <div>
              {agendaDays.length === 0 && (
                <p className="section-note">
                  No appointments in the next 30 days.
                </p>
              )}
              {agendaDays.map(({ day, items }) => (
                <div key={dayKey(day)} className="cal-agenda-day">
                  <h3>
                    {day.toLocaleDateString([], {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })}
                  </h3>
                  {items.map((a) => (
                    <button
                      key={a.id}
                      className="cal-day-row"
                      style={{ borderLeftColor: a.category_color }}
                      onClick={() => setSelectedId(a.id)}
                    >
                      <span className="cal-day-time">
                        {fmtRange(a)}
                      </span>
                      <span className="cal-day-full">
                        <strong>{a.patient_name ?? a.title}</strong>
                        <span className="card-meta">
                          {" "}
                          · {a.category_name}
                          {a.provider_name
                            ? ` · ${a.provider_name}`
                            : ""}{" "}
                          {agencyNameFor(a) ? ` · ${agencyNameFor(a)}` : ""} ·{" "}
                <span className={`cal-status cal-status-${statusMeta(a.status)?.tone ?? "gray"}`}>{statusLabel(a.status)}</span>
                        </span>
                      </span>
                      <span className="cal-day-compact">
                        <strong>{compactPatientName(a.patient_name) ?? a.title}</strong>
                        <span className="card-meta">
                          {" "}
                          · {shortCategoryName(a.category_name)}
                          {agencyNameFor(a) ? ` · ${agencyNameFor(a)}` : ""}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {view === "map" && (
            <DayScheduleMap
              date={mapDay}
              onDateChange={(d) => setMapDay(startOfDay(d))}
              appointments={visibleAppts}
              patients={patients}
              onOpenPatient={onOpenPatient}
            />
          )}

          {selected && (
            <article className="card cal-detail">
              <div className="card-top">
                <strong>
                  {selected.patient_name ?? selected.title}
                </strong>
                <span
                  className="kind-badge"
                  style={{
                    background: `${selected.category_color}1f`,
                    color: selected.category_color,
                  }}
                >
                  {selected.category_name}
                </span>
              </div>
              <p>
                {new Date(selected.starts_at).toLocaleDateString([], {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}{" "}
                · {fmtRange(selected)}
                {selected.provider_name &&
                  ` · with ${selected.provider_name}`}
                {selected.room && ` · ${selected.room}`}
              </p>
              {selected.notes && <p>{selected.notes}</p>}
              <div className="cal-detail-actions">
                <label>
                  Status{" "}
                  <select
                    value={statusGroup(selected.status)}
                    onChange={(e) =>
                      void changeStatus(selected, e.target.value)
                    }
                  >
                    {APPOINTMENT_STATUSES.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.label}
                      </option>
                    ))}
                    {!APPOINTMENT_STATUSES.some(
                      (s) => s.code === statusGroup(selected.status),
                    ) && (
                      <option value={selected.status}>
                        {statusLabel(selected.status)}
                      </option>
                    )}
                  </select>
                </label>
                {selected.patient_id && (
                  <button
                    className="btn"
                    onClick={() =>
                      selected.patient_id &&
                      onOpenPatient(selected.patient_id)
                    }
                  >
                    Open patient
                  </button>
                )}
                <button
                  className="btn"
                  onClick={() => openEdit(selected)}
                >
                  Edit
                </button>
                {isManager &&
                  (confirmingDelete ? (
                    <>
                      <button
                        className="btn btn-danger"
                        onClick={() => void doDelete()}
                      >
                        Confirm delete
                      </button>
                      <button
                        className="btn"
                        onClick={() => setConfirmingDelete(false)}
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn-danger"
                      onClick={() => setConfirmingDelete(true)}
                    >
                      Delete
                    </button>
                  ))}
              </div>
            </article>
          )}

          {formOpen && (
            <article className="card cal-form">
              <h3>{editing ? "Edit appointment" : "New appointment"}</h3>
              <div className="form-grid">
                {catById(fCategory)?.cattype !== "provider" && (
                  <div className="form-field">
                    <span>Patient</span>
                    {/* Text box with autocomplete (Jake, 2026-11-02):
                        type to filter ACTIVE patients, tap to pick.
                        A div wrapper, NOT a <label> — suggestion taps
                        inside a label get stolen (deploy-14 lesson).
                        Typing over a picked name un-picks it, so the
                        form can only save a real selection. */}
                    <div className="addr-wrap">
                      <input
                        type="text"
                        value={fPatientQuery}
                        placeholder="Type a patient name…"
                        autoComplete="off"
                        onFocus={() => setFPatientOpen(true)}
                        onBlur={() =>
                          window.setTimeout(
                            () => setFPatientOpen(false),
                            150,
                          )
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          setFPatientQuery(v);
                          setFPatientOpen(true);
                          const sel = patients.find(
                            (p) => p.id === fPatient,
                          );
                          if (sel && sel.name !== v) setFPatient("");
                        }}
                      />
                      {fPatientOpen && (
                        <div className="addr-drop" role="listbox">
                          {patientChoices.length === 0 ? (
                            <div className="addr-item addr-muted">
                              No active patients match
                            </div>
                          ) : (
                            patientChoices.map((p) => (
                              <div
                                key={p.id}
                                className="addr-item"
                                role="option"
                                aria-selected={p.id === fPatient}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  setFPatient(p.id);
                                  setFPatientQuery(p.name);
                                  setFPatientOpen(false);
                                }}
                              >
                                <span className={`dot dot-${p.zone}`} />{" "}
                                {p.name}
                                {(p.patientStatus ?? "active") !==
                                  "active" && " (not active)"}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <label>
                  Category
                  <select
                    value={fCategory}
                    onChange={(e) => {
                      setFCategory(e.target.value);
                      const c = catById(e.target.value);
                      if (c) setFDuration(c.default_duration_min);
                    }}
                  >
                    {cats.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.cattype === "provider" ? " (provider)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                                <label>
                  Provider
                  <select
                    value={fProvider}
                    onChange={(e) => setFProvider(e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {clinicians.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Title
                  <input
                    type="text"
                    value={fTitle}
                    onChange={(e) => setFTitle(e.target.value)}
                    placeholder={catById(fCategory)?.name ?? "Visit"}
                  />
                </label>
                <label>
                  Date
                  <input
                    type="date"
                    value={fDate}
                    onChange={(e) => setFDate(e.target.value)}
                  />
                </label>
                <label>
                  Start time
                  <input
                    type="time"
                    value={fTime}
                    onChange={(e) => setFTime(e.target.value)}
                  />
                </label>
                <label>
                  Duration
                  <select
                    value={fDuration}
                    onChange={(e) =>
                      setFDuration(Number(e.target.value))
                    }
                  >
                    {[15, 30, 45, 60, 90, 120].map((m) => (
                      <option key={m} value={m}>
                        {m} min
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Room
                  <input
                    type="text"
                    value={fRoom}
                    onChange={(e) => setFRoom(e.target.value)}
                    placeholder="Room 1"
                  />
                </label>
                {editing && (
                  <label>
                    Status
                    <select
                      value={fStatus}
                      onChange={(e) => setFStatus(e.target.value)}
                    >
                      {APPOINTMENT_STATUSES.map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.label}
                        </option>
                      ))}
                      {!APPOINTMENT_STATUSES.some(
                        (s) => s.code === statusGroup(fStatus),
                      ) && (
                        <option value={fStatus}>{statusLabel(fStatus)}</option>
                      )}
                    </select>
                  </label>
                )}
                <label className="form-wide">
                  Notes
                  <textarea
                    rows={2}
                    value={fNotes}
                    onChange={(e) => setFNotes(e.target.value)}
                  />
                </label>
              </div>
              <div className="cal-detail-actions">
                <button
                  className="btn btn-primary"
                  disabled={saving}
                  onClick={submitForm}
                >
                  {saving
                    ? "Saving…"
                    : editing
                      ? "Save changes"
                      : "Book appointment"}
                </button>
                <button
                  className="btn"
                  onClick={() => setFormOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </article>
          )}
        </>
      )}
    </section>
  );
}
