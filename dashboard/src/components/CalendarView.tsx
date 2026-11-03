import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import {
  createAppointment,
  createAppointmentSeries,
  deleteAppointment,
  isRoleRejection,
  listAppointmentCategories,
  listAppointmentStatuses,
  listAppointments,
  setAppointmentStatus,
  updateAppointment,
  updateAppointmentSeries,
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

// ---- Repeating visits: staggered phases (Jake, 2026-11-02) ----
// A series is built from phases like 2x/week for 2 weeks, then
// 1x/week for 1 week (a plan-of-care taper). Weeks are 7-day
// blocks starting on the first visit's date; inside a block, a
// k-times week lands on the FIRST k chosen weekdays of that
// block. Each visit becomes its own appointment row server-side,
// linked by a series id — one visit can move or cancel alone.
export interface SeriesPhase {
  perWeek: number;
  weeks: number;
}

export function generateSeriesDays(
  firstDay: Date,
  weekdays: number[],
  phases: SeriesPhase[],
): Date[] {
  const days: Date[] = [];
  const wanted = new Set(weekdays);
  let blockStart = new Date(firstDay);
  blockStart.setHours(12, 0, 0, 0);
  for (const phase of phases) {
    for (let w = 0; w < phase.weeks; w++) {
      const block: Date[] = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(blockStart, i);
        if (wanted.has(d.getDay())) block.push(d);
      }
      days.push(...block.slice(0, Math.max(0, phase.perWeek)));
      blockStart = addDays(blockStart, 7);
    }
  }
  return days.slice(0, 60);
}

export const WEEKDAY_CHIPS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

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
  // Simple entry card + series builder (Jake, 2026-11-02):
  // creating starts on the compact card; "More options" (or
  // editing) shows the full form.
  const [formSimple, setFormSimple] = useState(true);
  const [editScope, setEditScope] = useState<"single" | "series">(
    "single",
  );
  const [repOn, setRepOn] = useState(false);
  const [repWeekdays, setRepWeekdays] = useState<number[]>([1, 3, 5]);
  const [repPhases, setRepPhases] = useState<SeriesPhase[]>([
    { perWeek: 2, weeks: 2 },
  ]);
  const [deleteScope, setDeleteScope] = useState<
    "single" | "series" | null
  >(null);
  // Drag-between-days state (2026-11-02).
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);
  const dragRef = useRef<{
    appt: ApiAppointment;
    startX: number;
    startY: number;
    armed: boolean;
    ghost: HTMLElement | null;
    srcEl: HTMLElement;
    overDay: string | null;
    holdTimer: number | null;
    pointerType: string;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [saving, setSaving] = useState(false);

  // Delete is role-gated (manager/admin): managers get a
  // two-step confirm in place of the button.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    setConfirmingDelete(false);
    setDeleteScope(null);
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
    setFormSimple(true);
    setEditScope("single");
    setRepOn(false);
    setRepWeekdays([1, 3, 5]);
    setRepPhases([{ perWeek: 2, weeks: 2 }]);
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
    setFormSimple(false);
    setEditScope("single");
    setRepOn(false);
    setFormOpen(true);
  }

  // ---- Drag between days (Jake, 2026-11-02) -----------------
  // Pointer-events drag on month chips and week / 3-day blocks:
  // a mouse drag arms after a few px; a touch drag arms on a
  // short press-and-hold (so normal scrolling still works).
  // The drop changes only the DATE — the time of day and the
  // duration ride along — and saves through the ordinary
  // ungated appointment update.
  function cleanupDrag() {
    const d = dragRef.current;
    if (!d) return;
    if (d.holdTimer) window.clearTimeout(d.holdTimer);
    d.ghost?.remove();
    d.srcEl.classList.remove("cal-drag-src");
    dragRef.current = null;
    setDragOverDay(null);
  }

  async function moveAppointment(a: ApiAppointment, targetKey: string) {
    if (!user) return;
    const start = new Date(a.starts_at);
    const end = new Date(a.ends_at);
    const [y, m, dd] = targetKey.split("-").map(Number);
    const newStart = new Date(start);
    newStart.setFullYear(y, m - 1, dd);
    const newEnd = new Date(
      newStart.getTime() + (end.getTime() - start.getTime()),
    );
    try {
      const updated = await updateAppointment(user, a.id, {
        starts_at: newStart.toISOString(),
        ends_at: newEnd.toISOString(),
      });
      setAppts((prev) =>
        prev.map((x) => (x.id === updated.id ? updated : x)),
      );
    } catch {
      setNotice("Couldn't move that appointment — try again.");
    }
  }

  function beginDrag(
    e: React.PointerEvent,
    a: ApiAppointment,
    el: HTMLElement,
  ) {
    if (!apiConnected) return;
    const d = {
      appt: a,
      startX: e.clientX,
      startY: e.clientY,
      armed: false,
      ghost: null as HTMLElement | null,
      srcEl: el,
      overDay: null as string | null,
      holdTimer: null as number | null,
      pointerType: e.pointerType,
    };
    dragRef.current = d;
    const positionGhost = (x: number, y: number) => {
      if (!d.ghost) return;
      d.ghost.style.left = `${x - d.ghost.offsetWidth / 2}px`;
      d.ghost.style.top = `${y - 14}px`;
    };
    const arm = () => {
      if (dragRef.current !== d || d.armed) return;
      d.armed = true;
      const g = el.cloneNode(true) as HTMLElement;
      g.classList.add("cal-drag-ghost");
      g.style.width = `${el.offsetWidth}px`;
      document.body.appendChild(g);
      d.ghost = g;
      el.classList.add("cal-drag-src");
      positionGhost(d.startX, d.startY);
    };
    if (e.pointerType === "touch") {
      d.holdTimer = window.setTimeout(arm, 260);
    }
    const move = (ev: PointerEvent) => {
      if (dragRef.current !== d) return;
      const dist = Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY);
      if (!d.armed) {
        if (d.pointerType !== "touch" && dist > 6) arm();
        else if (d.pointerType === "touch" && dist > 10 && d.holdTimer) {
          window.clearTimeout(d.holdTimer);
          d.holdTimer = null;
        }
        return;
      }
      ev.preventDefault();
      positionGhost(ev.clientX, ev.clientY);
      const under = document.elementFromPoint(
        ev.clientX,
        ev.clientY,
      ) as HTMLElement | null;
      const cell = under?.closest?.("[data-day]") as HTMLElement | null;
      const key = cell?.dataset.day ?? null;
      d.overDay = key;
      setDragOverDay(key);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const wasArmed = d.armed;
      const target = d.overDay;
      const appt = d.appt;
      cleanupDrag();
      if (wasArmed) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 80);
        if (target && target !== toDateInput(new Date(appt.starts_at))) {
          void moveAppointment(appt, target);
        }
      }
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  // ---- Series preview (dates the Repeats settings produce) ---
  const seriesDays = useMemo(() => {
    if (!repOn || !fDate) return [];
    const base = new Date(`${fDate}T12:00:00`);
    if (Number.isNaN(base.getTime())) return [];
    return generateSeriesDays(base, repWeekdays, repPhases);
  }, [repOn, fDate, repWeekdays, repPhases]);
  const seriesStarts = useMemo(() => {
    const [h, mi] = (fTime || "09:00").split(":").map(Number);
    return seriesDays.map((d) => {
      const s = new Date(d);
      s.setHours(h || 0, mi || 0, 0, 0);
      return s;
    });
  }, [seriesDays, fTime]);
  const setPhase = (i: number, patch: Partial<SeriesPhase>) =>
    setRepPhases((prev) =>
      prev.map((x, j) => (j === i ? { ...x, ...patch } : x)),
    );

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
      // Series-wide edit: only the shared fields travel; dates
      // and times stay per-visit by design.
      if (editing && editScope === "series" && editing.series_id) {
        const rows = await updateAppointmentSeries(
          user,
          editing.series_id,
          {
            category_id: fCategory,
            provider_id: fProvider || null,
            title: fTitle.trim() || undefined,
            room: fRoom.trim() || null,
            notes: fNotes.trim() || null,
          },
        );
        setAppts((prev) =>
          prev.map((a) => rows.find((r) => r.id === a.id) ?? a),
        );
        setFormOpen(false);
        setNotice(`Saved changes to ${rows.length} series visits.`);
        return;
      }
      // Series create: the server makes one row per visit under
      // one series id, in a single transaction.
      if (!editing && repOn && seriesStarts.length > 1) {
        const out = await createAppointmentSeries(user, {
          ...buildInput(),
          duration_min: fDuration,
          visits: seriesStarts.map((d) => d.toISOString()),
        });
        setRefreshTick((t) => t + 1);
        setFormOpen(false);
        setNotice(
          `Created ${out.appointments.length} appointments in the series.`,
        );
        return;
      }
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
    if (!editing && repOn) {
      if (repWeekdays.length === 0)
        return setNotice("Pick at least one visit day for the series.");
      if (seriesStarts.length === 0)
        return setNotice("The series settings produce no visits.");
    }
    void doSave();
  }

  async function doDelete() {
    if (!selected) return;
    try {
      if (deleteScope === "series" && selected.series_id) {
        const sid = selected.series_id;
        await deleteAppointment(user, selected.id, "series");
        setAppts((prev) => prev.filter((a) => a.series_id !== sid));
      } else {
        await deleteAppointment(user, selected.id);
        setAppts((prev) => prev.filter((a) => a.id !== selected.id));
      }
      setSelectedId(null);
      setConfirmingDelete(false);
      setDeleteScope(null);
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
      onPointerDown={(e) => beginDrag(e, a, e.currentTarget)}
      onClick={(e) => {
        e.stopPropagation();
        if (suppressClickRef.current) return;
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
                      className={`cal-cell${inMonth ? "" : " cal-out"}${isToday ? " cal-today" : ""}${selectedDay === dayKey(day) ? " cal-selected" : ""}${dragOverDay === toDateInput(day) ? " cal-drop" : ""}`}
                      data-day={toDateInput(day)}
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
                  <div
                    key={dayKey(day)}
                    className={`cal-week-day${dragOverDay === toDateInput(day) ? " cal-drop" : ""}`}
                    data-day={toDateInput(day)}
                  >
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
                        onPointerDown={(e) =>
                          beginDrag(e, a, e.currentTarget)
                        }
                        onClick={() => {
                          if (suppressClickRef.current) return;
                          setSelectedId(a.id);
                        }}
                      >
                        <strong>{fmtRange(a)}</strong>
                        <span>
                          {a.patient_name ?? a.title}
                        </span>
                        <span className="card-meta">
                          {a.series_id ? "↻ " : ""}
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
                {selected.series_id && (
                  <span className="kind-badge cal-series-badge">
                    ↻ Series
                  </span>
                )}
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
                  (confirmingDelete &&
                  selected.series_id &&
                  deleteScope === null ? (
                    <>
                      <button
                        className="btn btn-danger"
                        onClick={() => setDeleteScope("single")}
                      >
                        Delete this visit
                      </button>
                      <button
                        className="btn btn-danger"
                        onClick={() => setDeleteScope("series")}
                      >
                        Delete whole series
                      </button>
                      <button
                        className="btn"
                        onClick={() => setConfirmingDelete(false)}
                      >
                        Keep
                      </button>
                    </>
                  ) : confirmingDelete ? (
                    <>
                      <button
                        className="btn btn-danger"
                        onClick={() => void doDelete()}
                      >
                        {deleteScope === "series"
                          ? "Confirm: delete whole series"
                          : "Confirm delete"}
                      </button>
                      <button
                        className="btn"
                        onClick={() => {
                          setConfirmingDelete(false);
                          setDeleteScope(null);
                        }}
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
              {editing?.series_id && (
                <div className="cal-scope-row">
                  <span>Part of a series — apply changes to:</span>
                  <label>
                    <input
                      type="radio"
                      name="edit-scope"
                      checked={editScope === "single"}
                      onChange={() => setEditScope("single")}
                    />{" "}
                    This visit only
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="edit-scope"
                      checked={editScope === "series"}
                      onChange={() => setEditScope("series")}
                    />{" "}
                    Whole series
                  </label>
                  {editScope === "series" && (
                    <span className="cal-scope-note">
                      Type, provider, title, room and notes change for
                      every visit; dates and times stay per-visit.
                    </span>
                  )}
                </div>
              )}
              {!editing && formSimple ? (
                <div className="form-grid">
                  {catById(fCategory)?.cattype !== "provider" && (
                    <div className="form-field">
                      <span>Patient</span>
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
                              patientChoices.map((pc) => (
                                <div
                                  key={pc.id}
                                  className="addr-item"
                                  role="option"
                                  aria-selected={pc.id === fPatient}
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    setFPatient(pc.id);
                                    setFPatientQuery(pc.name);
                                    setFPatientOpen(false);
                                  }}
                                >
                                  <span
                                    className={`dot dot-${pc.zone}`}
                                  />{" "}
                                  {pc.name}
                                  {(pc.patientStatus ?? "active") !==
                                    "active" && " (not active)"}
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="form-field form-wide">
                    <span>Visit type</span>
                    <div className="cal-chiprow">
                      {cats
                        .filter((c) => c.cattype === "appointment")
                        .map((c) => (
                          <button
                            type="button"
                            key={c.id}
                            className={`cal-chipbtn${String(c.id) === fCategory ? " on" : ""}`}
                            style={{ borderColor: c.color }}
                            onClick={() => {
                              setFCategory(String(c.id));
                              setFDuration(c.default_duration_min);
                            }}
                          >
                            {c.name}
                          </button>
                        ))}
                    </div>
                  </div>
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
                </div>
              ) : (
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
              )}
              {!editing && (
                <div className="cal-repeats">
                  <label className="cal-repeats-toggle">
                    <input
                      type="checkbox"
                      checked={repOn}
                      onChange={(e) => setRepOn(e.target.checked)}
                    />{" "}
                    Repeats — build a series of visits
                  </label>
                  {repOn && (
                    <>
                      <div className="cal-repeats-days">
                        <span>Visit days</span>
                        <div className="cal-chiprow">
                          {WEEKDAY_CHIPS.map((label, d) => (
                            <button
                              type="button"
                              key={d}
                              className={`cal-chipbtn${repWeekdays.includes(d) ? " on" : ""}`}
                              onClick={() =>
                                setRepWeekdays((prev) =>
                                  prev.includes(d)
                                    ? prev.filter((x) => x !== d)
                                    : [...prev, d].sort((a, b) => a - b),
                                )
                              }
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {repPhases.map((ph, i) => {
                        const startWeek =
                          repPhases
                            .slice(0, i)
                            .reduce((n, x) => n + x.weeks, 0) + 1;
                        const endWeek = startWeek + ph.weeks - 1;
                        return (
                          <div className="cal-phase" key={i}>
                            <span className="cal-phase-label">
                              {ph.weeks === 1
                                ? `Week ${startWeek}`
                                : `Weeks ${startWeek}–${endWeek}`}
                            </span>
                            <span className="cal-stepper">
                              <button
                                type="button"
                                onClick={() =>
                                  setPhase(i, {
                                    perWeek: Math.max(1, ph.perWeek - 1),
                                  })
                                }
                              >
                                −
                              </button>
                              <strong>{ph.perWeek}×</strong>
                              <button
                                type="button"
                                onClick={() =>
                                  setPhase(i, {
                                    perWeek: Math.min(5, ph.perWeek + 1),
                                  })
                                }
                              >
                                +
                              </button>
                            </span>
                            <span>/ week for</span>
                            <span className="cal-stepper">
                              <button
                                type="button"
                                onClick={() =>
                                  setPhase(i, {
                                    weeks: Math.max(1, ph.weeks - 1),
                                  })
                                }
                              >
                                −
                              </button>
                              <strong>{ph.weeks} wk</strong>
                              <button
                                type="button"
                                onClick={() =>
                                  setPhase(i, {
                                    weeks: Math.min(12, ph.weeks + 1),
                                  })
                                }
                              >
                                +
                              </button>
                            </span>
                            {repPhases.length > 1 && (
                              <button
                                type="button"
                                className="cal-phase-remove"
                                onClick={() =>
                                  setRepPhases((prev) =>
                                    prev.filter((_, j) => j !== i),
                                  )
                                }
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {repPhases.length < 6 && (
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() =>
                            setRepPhases((prev) => [
                              ...prev,
                              { perWeek: 1, weeks: 1 },
                            ])
                          }
                        >
                          + Add phase
                        </button>
                      )}
                      <p className="cal-repeats-preview">
                        {seriesStarts.length === 0
                          ? "Pick a date and at least one visit day."
                          : `${seriesStarts.length} visits · ${seriesStarts[0].toLocaleDateString([], { month: "short", day: "numeric" })} – ${seriesStarts[seriesStarts.length - 1].toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })} · every visit is its own appointment — one can move or cancel alone`}
                      </p>
                    </>
                  )}
                </div>
              )}
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
                      : repOn && seriesStarts.length > 1
                        ? `Book ${seriesStarts.length} appointments`
                        : "Book appointment"}
                </button>
                {!editing && (
                  <button
                    className="btn"
                    onClick={() => setFormSimple((v) => !v)}
                  >
                    {formSimple ? "More options" : "Fewer options"}
                  </button>
                )}
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
