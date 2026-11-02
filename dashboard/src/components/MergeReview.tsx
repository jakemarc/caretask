import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  dismissMergeMark,
  fetchMergeMarks,
  fetchMerges,
  isRoleRejection,
  mergePatients,
  undoMerge,
  type MergeMark,
  type MergePatientSummary,
  type MergeRecord,
} from "../lib/patientApi";

// Patients tab → duplicate review (patient merge round, 2026-11-02).
// Shows the open mark-for-merge pairs with a side-by-side compare
// and a Keep choice, plus the recent-merges list with Undo. The
// merge itself is manager/admin-gated at the API; non-managers can
// mark and dismiss but see the merge button disabled with the
// reason. Refetches whenever the Patients tab becomes visible, so
// marks made from a patient profile show up on arrival.

interface Props {
  user: User;
  visible: boolean;
  isManager: boolean;
  onMerged: (survivorId: string, loserId: string) => void;
  onOpenPatient: (id: string) => void;
}

function completeness(p: MergePatientSummary): number {
  return [
    p.date_of_birth,
    p.address,
    p.phone_cell,
    p.phone_home,
    p.email,
    p.agency_id != null || p.agency_name_text ? "agency" : null,
  ].filter(Boolean).length;
}

function movedText(m: MergeRecord): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(m.moved.appointments, "appointment", "appointments");
  add(m.moved.documents, "document", "documents");
  add(m.moved.messages, "message", "messages");
  add(m.moved.mileage_entries, "mileage leg", "mileage legs");
  return parts.length > 0 ? parts.join(" · ") : "no linked records";
}

function SummaryPanel({
  p,
  kept,
  onKeep,
  onOpen,
}: {
  p: MergePatientSummary;
  kept: boolean;
  onKeep: () => void;
  onOpen: () => void;
}) {
  const facts: Array<[string, string | null]> = [
    ["Born", p.date_of_birth ?? (p.age != null ? `Age ${p.age}` : null)],
    ["Address", p.address],
    ["Cell", p.phone_cell],
    ["Home phone", p.phone_home],
    ["Email", p.email],
    [
      "Agency",
      p.agency_name_text ??
        (p.agency_id != null ? `Agency #${p.agency_id}` : null),
    ],
    ["Status", p.status],
  ];
  return (
    <div className={`merge-panel${kept ? " kept" : ""}`}>
      <button
        type="button"
        className="merge-panel-name"
        onClick={onOpen}
        title="Open this profile"
      >
        {p.name || "Unnamed patient"}
      </button>
      <dl className="merge-facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v ?? "—"}</dd>
          </div>
        ))}
      </dl>
      <label className="merge-keep">
        <input type="radio" checked={kept} onChange={onKeep} />
        Keep this record
      </label>
    </div>
  );
}

export default function MergeReview({
  user,
  visible,
  isManager,
  onMerged,
  onOpenPatient,
}: Props) {
  const [marks, setMarks] = useState<MergeMark[]>([]);
  const [merges, setMerges] = useState<MergeRecord[]>([]);
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [mk, mg] = await Promise.all([
        fetchMergeMarks(user),
        fetchMerges(user),
      ]);
      setMarks(mk);
      setMerges(mg);
      setKeep((prev) => {
        const next = { ...prev };
        for (const m of mk) {
          const key = `${m.patient_low}|${m.patient_high}`;
          if (!next[key]) {
            next[key] =
              completeness(m.patient_b) > completeness(m.patient_a)
                ? m.patient_b.id
                : m.patient_a.id;
          }
        }
        return next;
      });
    } catch {
      // A failed load just hides the card; the patient list itself
      // is unaffected.
      setMarks([]);
      setMerges([]);
    }
  }

  useEffect(() => {
    if (visible) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, user]);

  if (marks.length === 0 && merges.length === 0) return null;

  async function handleMerge(mark: MergeMark) {
    const key = `${mark.patient_low}|${mark.patient_high}`;
    const survivorId = keep[key] ?? mark.patient_a.id;
    const loserId =
      survivorId === mark.patient_a.id ? mark.patient_b.id : mark.patient_a.id;
    setBusy(true);
    setError(null);
    try {
      await mergePatients(user, survivorId, loserId);
      onMerged(survivorId, loserId);
      await load();
    } catch (err) {
      setError(
        isRoleRejection(err)
          ? "Merging needs a manager or admin role."
          : "The merge did not go through — please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDismiss(mark: MergeMark) {
    setBusy(true);
    setError(null);
    try {
      await dismissMergeMark(user, mark.patient_a.id, mark.patient_b.id);
      await load();
    } catch {
      setError("That mark could not be dismissed — please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo(m: MergeRecord) {
    setBusy(true);
    setError(null);
    try {
      await undoMerge(user, m.id);
      onMerged(m.loser_id, m.survivor_id);
      await load();
    } catch (err) {
      setError(
        isRoleRejection(err)
          ? "Undoing a merge needs a manager or admin role."
          : "The undo did not go through — please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="merge-card">
      {marks.length > 0 && (
        <>
          <h3 className="merge-title">
            Possible duplicates ({marks.length})
          </h3>
          <p className="section-note">
            Marked as the same person twice. Pick the record to keep —
            the other one is retired (never deleted), and its
            appointments, documents, messages, and mileage move to the
            kept record. A merge can be undone below.
          </p>
        </>
      )}
      {marks.map((mark) => {
        const key = `${mark.patient_low}|${mark.patient_high}`;
        const keptId = keep[key] ?? mark.patient_a.id;
        return (
          <div className="merge-pair" key={key}>
            <div className="merge-panels">
              <SummaryPanel
                p={mark.patient_a}
                kept={keptId === mark.patient_a.id}
                onKeep={() =>
                  setKeep((prev) => ({ ...prev, [key]: mark.patient_a.id }))
                }
                onOpen={() => onOpenPatient(mark.patient_a.id)}
              />
              <SummaryPanel
                p={mark.patient_b}
                kept={keptId === mark.patient_b.id}
                onKeep={() =>
                  setKeep((prev) => ({ ...prev, [key]: mark.patient_b.id }))
                }
                onOpen={() => onOpenPatient(mark.patient_b.id)}
              />
            </div>
            <div className="merge-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !isManager}
                title={
                  isManager
                    ? undefined
                    : "Merging needs a manager or admin role"
                }
                onClick={() => void handleMerge(mark)}
              >
                Merge duplicates
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void handleDismiss(mark)}
              >
                Not duplicates
              </button>
              {!isManager && (
                <span className="merge-role-note">
                  Merging needs a manager or admin.
                </span>
              )}
            </div>
          </div>
        );
      })}
      {error && <p className="pin-error">{error}</p>}
      {merges.length > 0 && (
        <div className="merge-history">
          <h4>Recent merges</h4>
          {merges.map((m) => (
            <div className="merge-history-row" key={m.id}>
              <span>
                <strong>{m.loser_name}</strong> merged into{" "}
                <strong>{m.survivor_name}</strong> — {movedText(m)} moved ·
                by {m.merged_by}
                {m.undone_at ? " · undone" : ""}
              </span>
              {!m.undone_at && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={busy || !isManager}
                  title={
                    isManager
                      ? undefined
                      : "Undoing a merge needs a manager or admin role"
                  }
                  onClick={() => void handleUndo(m)}
                >
                  Undo
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
