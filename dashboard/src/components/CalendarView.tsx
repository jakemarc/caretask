import { useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import {
  createAppointment,
  deleteAppointment,
  isPinRejection,
  listAppointmentCategories,
  listAppointmentStatuses,
  listAppointments,
  setAppointmentStatus,
  updateAppointment,
  verifyManagerPin,
  type ApiAppointment,
  type AppointmentCategory,
  type AppointmentStatusInfo,
} from "../lib/patientApi";
import DayScheduleMap from "./DayScheduleMap";
import type { MapPatientLike } from "../lib/geo";

// Google Calendar-style appointment view backed by the CareTask
// appointments API (OpenEMR-correlated model: categories carry the
// color + default duration, provider is a staff member, statuses
// come from the API's flow list). Month / Week / Agenda views,
// click-a-day booking, one-click status changes (flow board), and
// manager-PIN gates on edit/delete — the same rules as patients.

type CalView = "month" | "week" | "agenda" | "map";

interface Props {
  user: User;
  apiConnected: boolean;
  patients: MapPatientLike[];
  clinicians: { id: string; name: string }[];
  onOpenPatient: (id: string) => void;
}

const DAY_MS = 86400000;

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
  onOpenPatient,
}: Props) {
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Form state (null = closed). editing = the appointment being
  // edited, or null for a new one.
  const [editing, setEditing] = useState<ApiAppointment | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [fPatient, setFPatient] = useState("");
  const [fProvider, setFProvider] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fTitle, setFTitle] = useState("");
  const [fDate, setFDate] = useState("");
  const [fTime, setFTime] = useState("09:00");
  const [fDuration, setFDuration] = useState(45);
  const [fRoom, setFRoom] = useState("");
  const [fNotes, setFNotes] = useState("");
  const [fStatus, setFStatus] = useState("booked");
  const [saving, setSaving] = useState(false);

  // Manager-PIN gate for edit-save and delete (mirrors the staff
  // pattern: verified PIN held in memory only while this view lives).
  const [gate, setGate] = useState<"save" | "delete" | null>(null);
  const [pinEntry, setPinEntry] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinChecking, setPinChecking] = useState(false);
  const [verifiedPin, setVerifiedPin] = useState("");
  const [authorizer, setAuthorizer] = useState("");

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

  const byDay = useMemo(() => {
    const map = new Map<string, ApiAppointment[]>();
    for (const a of appts) {
      const k = dayKey(new Date(a.starts_at));
      const arr = map.get(k) ?? [];
      arr.push(a);
      map.set(k, arr);
    }
    return map;
  }, [appts]);

  const selected = appts.find((a) => a.id === selectedId) ?? null;
  const statusLabel = (code: string) =>
    statuses.find((s) => s.code === code)?.label ?? code;
  const catById = (id: string) => cats.find((c) => c.id === id);

  function step(dir: number) {
    if (view === "month")
      setAnchor(
        (a) => new Date(a.getFullYear(), a.getMonth() + dir, 1),
      );
    else if (view === "map") setMapDay((d) => addDays(d, dir));
    else if (view === "week") setAnchor((a) => addDays(a, dir * 7));
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
    if (view === "map")
      return mapDay.toLocaleDateString([], {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    return "Next 30 days";
  }, [view, anchor, mapDay]);

  function openCreate(day: Date, hour = 9) {
    const firstCat =
      cats.find((c) => c.cattype === "appointment") ?? cats[0];
    setEditing(null);
    setFPatient(patients[0]?.id ?? "");
    setFProvider("");
    setFCategory(firstCat ? String(firstCat.id) : "");
    setFTitle("");
    const d = startOfDay(day);
    d.setHours(hour, 0, 0, 0);
    setFDate(toDateInput(d));
    setFTime(toTimeInput(d));
    setFDuration(firstCat?.default_duration_min ?? 45);
    setFRoom("");
    setFNotes("");
    setFStatus("booked");
    setGate(null);
    setFormOpen(true);
  }

  function openEdit(a: ApiAppointment) {
    setEditing(a);
    setFPatient(a.patient_id ?? "");
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
    setFStatus(a.status);
    setGate(null);
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

  async function doSave(pin?: string) {
    setSaving(true);
    setNotice("");
    try {
      if (editing) {
        const updated = await updateAppointment(
          user,
          editing.id,
          buildInput(),
          pin ?? verifiedPin,
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
      setGate(null);
    } catch (err) {
      if (isPinRejection(err)) {
        setVerifiedPin("");
        setGate("save");
        setPinError("That PIN was rejected — try again.");
      } else {
        setNotice(
          err instanceof Error ? err.message : "Couldn't save the appointment.",
        );
      }
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
    if (editing && !verifiedPin) {
      setPinError("");
      setPinEntry("");
      setGate("save");
      return;
    }
    void doSave();
  }

  async function doDelete(pin: string) {
    if (!selected) return;
    try {
      await deleteAppointment(user, selected.id, pin);
      setAppts((prev) => prev.filter((a) => a.id !== selected.id));
      setSelectedId(null);
      setGate(null);
    } catch (err) {
      if (isPinRejection(err)) {
        setVerifiedPin("");
        setPinError("That PIN was rejected — try again.");
      } else {
        setNotice("Couldn't delete the appointment.");
      }
    }
  }

  async function submitPin() {
    const pin = pinEntry.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      setPinError("PINs are 4–8 digits.");
      return;
    }
    setPinChecking(true);
    setPinError("");
    try {
      const manager = await verifyManagerPin(user, pin);
      setVerifiedPin(pin);
      setAuthorizer(manager.name);
      if (gate === "save") void doSave(pin);
      else if (gate === "delete") void doDelete(pin);
    } catch {
      setPinError("Incorrect PIN.");
    } finally {
      setPinChecking(false);
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
      className={`cal-chip${a.status === "cancelled" || a.status === "no_show" ? " cal-chip-muted" : ""}`}
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

  const agendaDays = useMemo(() => {
    const days: { day: Date; items: ApiAppointment[] }[] = [];
    const sorted = [...appts].sort(
      (x, y) => +new Date(x.starts_at) - +new Date(y.starts_at),
    );
    for (const a of sorted) {
      const k = dayKey(new Date(a.starts_at));
      const last = days[days.length - 1];
      if (last && dayKey(last.day) === k) last.items.push(a);
      else days.push({ day: new Date(a.starts_at), items: [a] });
    }
    return days;
  }, [appts]);

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
            <span>
              <strong>{a.patient_name ?? a.title}</strong>
              <span className="card-meta">
                {" "}
                · {a.category_name}
                {a.provider_name ? ` · ${a.provider_name}` : ""} ·{" "}
                {statusLabel(a.status)}
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
      <h1>Appointment</h1>
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
              {(["month", "week", "agenda", "map"] as CalView[]).map((v) => (
                <button
                  key={v}
                  className={view === v ? "btn btn-primary" : "btn"}
                  onClick={() => setView(v)}
                >
                  {v[0].toUpperCase() + v.slice(1)}
                </button>
              ))}
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
                      {items.slice(0, 3).map(chip)}
                      {items.length > 3 && (
                        <span className="cal-more">
                          +{items.length - 3} more
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {dayList(
                monthCells.find((d) => dayKey(d) === selectedDay) ??
                  new Date(),
              )}
            </>
          )}

          {view === "week" && (
            <div className="cal-week">
              {weekDays.map((day) => {
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
                      <span>
                        <strong>{a.patient_name ?? a.title}</strong>
                        <span className="card-meta">
                          {" "}
                          · {a.category_name}
                          {a.provider_name
                            ? ` · ${a.provider_name}`
                            : ""}{" "}
                          · {statusLabel(a.status)}
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
              appointments={appts}
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
                    value={selected.status}
                    onChange={(e) =>
                      void changeStatus(selected, e.target.value)
                    }
                  >
                    {statuses.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.label}
                      </option>
                    ))}
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
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    if (verifiedPin) void doDelete(verifiedPin);
                    else {
                      setPinError("");
                      setPinEntry("");
                      setGate("delete");
                    }
                  }}
                >
                  Delete
                </button>
              </div>
              {authorizer && (
                <p className="card-meta">
                  Manager PIN verified for {authorizer} — edits and
                  deletes this session skip the prompt.
                </p>
              )}
            </article>
          )}

          {gate && (
            <form
              className="pin-panel"
              onSubmit={(e) => {
                e.preventDefault();
                void submitPin();
              }}
            >
              <label>
                Manager PIN required to{" "}
                {gate === "save"
                  ? "save changes to this appointment"
                  : "delete this appointment"}
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pinEntry}
                  onChange={(e) => setPinEntry(e.target.value)}
                  placeholder="PIN"
                />
              </label>
              <p>
                Enter any active manager or admin PIN. The change is
                recorded under that manager's name.
              </p>
              {pinError && <p className="pin-error">{pinError}</p>}
              <div className="profile-actions">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={pinChecking}
                >
                  {pinChecking ? "Verifying…" : "Unlock"}
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => setGate(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {formOpen && (
            <article className="card cal-form">
              <h3>{editing ? "Edit appointment" : "New appointment"}</h3>
              <div className="form-grid">
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
                {catById(fCategory)?.cattype !== "provider" && (
                  <label>
                    Patient
                    <select
                      value={fPatient}
                      onChange={(e) => setFPatient(e.target.value)}
                    >
                      <option value="">Select a patient…</option>
                      {patients.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
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
                      {statuses.map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.label}
                        </option>
                      ))}
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
