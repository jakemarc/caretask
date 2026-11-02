import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  createTask,
  deleteTask,
  fetchTasks,
  updateTask,
  type ClinicianTask,
} from "../lib/tasksApi";
import type { PersonUnderCare } from "../lib/demoData";

// Clinician tasks (todo/reminder list, 2026-11-02). Two surfaces,
// one component:
// - overview: the Dashboard overview panel — Due today / Overdue
//   first, then everything open, with the add form (optional
//   patient link) and a done section.
// - patient: the Patient Profile block — this patient's reminders
//   with an add form pre-linked to the patient.
// Tasks are the signed-in clinician's own (owner-scoped at the
// API). In-app only — nothing here messages the patient.

interface OverviewProps {
  variant: "overview";
  user: User;
  visible: boolean;
  people: PersonUnderCare[];
  onOpenPatient: (id: string) => void;
}

interface PatientProps {
  variant: "patient";
  user: User;
  patientId: string;
}

type Props = OverviewProps | PatientProps;

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dueBucket(t: ClinicianTask): "overdue" | "today" | "upcoming" | "nodate" {
  if (!t.due_at) return "nodate";
  const due = localDateKey(new Date(t.due_at));
  const today = localDateKey(new Date());
  if (due < today) return "overdue";
  if (due === today) return "today";
  return "upcoming";
}

function dueLabel(t: ClinicianTask): string | null {
  if (!t.due_at) return null;
  const d = new Date(t.due_at);
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  const bucket = dueBucket(t);
  if (bucket === "overdue") return `Overdue · ${date}`;
  if (bucket === "today") return "Due today";
  return `Due ${date}`;
}

export default function TasksPanel(props: Props) {
  const { user } = props;
  const patientId = props.variant === "patient" ? props.patientId : undefined;
  const visible = props.variant === "overview" ? props.visible : true;
  const [tasks, setTasks] = useState<ClinicianTask[] | null>(null);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [linkId, setLinkId] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setTasks(await fetchTasks(user, patientId));
    } catch {
      setTasks([]);
    }
  }

  useEffect(() => {
    if (visible) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, user, patientId]);

  if (tasks === null) return null;
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const overdueCount = open.filter((t) => dueBucket(t) === "overdue").length;
  const todayCount = open.filter((t) => dueBucket(t) === "today").length;
  const orderedOpen = [...open].sort((a, b) => {
    const rank = (t: ClinicianTask) =>
      ({ overdue: 0, today: 1, upcoming: 2, nodate: 3 })[dueBucket(t)];
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.due_at ?? "").localeCompare(b.due_at ?? "");
  });

  async function handleAdd() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createTask(user, {
        title: t,
        patient_id:
          props.variant === "patient"
            ? props.patientId
            : linkId || null,
        due_at: due ? new Date(`${due}T09:00`).toISOString() : null,
      });
      setTasks((prev) => (prev ? [created, ...prev] : [created]));
      setTitle("");
      setDue("");
      setLinkId("");
    } catch {
      setError("That reminder didn't save — please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(t: ClinicianTask) {
    try {
      const updated = await updateTask(user, t.id, { done: !t.done });
      setTasks((prev) =>
        prev ? prev.map((x) => (x.id === t.id ? updated : x)) : prev,
      );
    } catch {
      setError("That change didn't save — please try again.");
    }
  }

  async function handleDelete(t: ClinicianTask) {
    try {
      await deleteTask(user, t.id);
      setTasks((prev) => (prev ? prev.filter((x) => x.id !== t.id) : prev));
    } catch {
      setError("That reminder couldn't be removed — please try again.");
    }
  }

  function row(t: ClinicianTask) {
    const label = dueLabel(t);
    const bucket = dueBucket(t);
    return (
      <div className={`task-row${t.done ? " done" : ""}`} key={t.id}>
        <input
          type="checkbox"
          checked={t.done}
          onChange={() => void handleToggle(t)}
          aria-label={t.done ? "Reopen this reminder" : "Mark this reminder done"}
        />
        <span className="task-title">{t.title}</span>
        {props.variant === "overview" && t.patient_id && (
          <button
            type="button"
            className="task-patient-chip"
            onClick={() => props.onOpenPatient(t.patient_id as string)}
          >
            {t.patient_name ?? "Patient"}
          </button>
        )}
        {label && (
          <span className={`task-due ${bucket}`}>{label}</span>
        )}
        <button
          type="button"
          className="task-del"
          aria-label="Remove this reminder"
          onClick={() => void handleDelete(t)}
        >
          ×
        </button>
      </div>
    );
  }

  const body = (
    <>
      {props.variant === "overview" && (overdueCount > 0 || todayCount > 0) && (
        <p className="task-strip">
          {overdueCount > 0 && (
            <span className="task-strip-overdue">
              {overdueCount} overdue
            </span>
          )}
          {todayCount > 0 && <span>{todayCount} due today</span>}
        </p>
      )}
      <div className="task-list">
        {orderedOpen.length === 0 && (
          <p className="section-note">Nothing open. Nice and clear.</p>
        )}
        {orderedOpen.map(row)}
      </div>
      <div className="task-add">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleAdd();
          }}
          placeholder={
            props.variant === "patient"
              ? "Add a reminder for this patient…"
              : "Add a reminder…"
          }
          aria-label="New reminder"
        />
        <input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          aria-label="Due date (optional)"
        />
        {props.variant === "overview" && (
          <select
            value={linkId}
            onChange={(e) => setLinkId(e.target.value)}
            aria-label="Link to a patient (optional)"
          >
            <option value="">No patient</option>
            {props.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !title.trim()}
          onClick={() => void handleAdd()}
        >
          Add
        </button>
      </div>
      {error && <p className="pin-error">{error}</p>}
      {done.length > 0 && (
        <div className="task-done">
          <button
            type="button"
            className="task-done-toggle"
            onClick={() => setShowDone((v) => !v)}
          >
            {showDone ? "Hide" : "Show"} done ({done.length})
          </button>
          {showDone && <div className="task-list">{done.map(row)}</div>}
        </div>
      )}
    </>
  );

  if (props.variant === "patient") {
    return (
      <article className="card tasks-block">
        <strong>Reminders</strong>
        <p className="card-meta">
          Your reminders for this patient — only you see these.
        </p>
        {body}
      </article>
    );
  }
  return (
    <div className="overview-panel tasks-panel">
      <h2>My reminders</h2>
      {body}
    </div>
  );
}
