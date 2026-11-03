// Patient Profile → Episode of care (platform, 2026-11-03).
// The episode is the unit of sharing: one active episode per
// patient across the whole platform, held by one agency, worked
// by a team (one primary + members). This card shows the current
// episode and its team, the episode history, and — below — the
// patient's master schedule: every team member's visits with
// provider names, the patient-centric counterpart to the personal
// Calendar tab. Actions are shown when the API will accept them
// (primary / agency manager / platform admin); the API enforces.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import {
  addEpisodeMember,
  createEpisode,
  dateOnly,
  DISCHARGE_REASONS,
  dischargeEpisode,
  dischargeReasonLabel,
  fetchEpisodes,
  fetchMyAgencies,
  HOLD_REASONS,
  holdEpisode,
  holdReasonLabel,
  listAppointments,
  listClinicians,
  recertifyEpisode,
  removeEpisodeMember,
  resumeEpisode,
  transferCaseManager,
  transferEpisodePrimary,
  type ApiAppointment,
  type ApiEpisode,
  type ApiMyAgency,
  type ApiRequestError,
  type ApiUser,
} from "../lib/patientApi";
import { isManagerRole, useMyStaff } from "../lib/useMyRole";

interface Props {
  user: User;
  patientId: string;
}

function fmtDay(value: string | null): string {
  const d = dateOnly(value);
  if (!d) return "—";
  const parsed = new Date(`${d}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? d
    : parsed.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

function fmtVisit(a: ApiAppointment): string {
  const start = new Date(a.starts_at);
  const day = start.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = start.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day} · ${time}`;
}

export default function EpisodeCard({ user, patientId }: Props) {
  const me = useMyStaff(user);
  const [episodes, setEpisodes] = useState<ApiEpisode[] | null>(null);
  const [myAgencies, setMyAgencies] = useState<ApiMyAgency[]>([]);
  const [colleagues, setColleagues] = useState<ApiUser[]>([]);
  const [schedule, setSchedule] = useState<ApiAppointment[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // Start-episode form.
  const [startAgencyId, setStartAgencyId] = useState<string>("");
  // Team form.
  const [addUserId, setAddUserId] = useState("");
  const [addSupervisorId, setAddSupervisorId] = useState("");
  // Discharge / recertify / hold confirms.
  const [confirming, setConfirming] = useState<
    null | "discharge" | "recertify" | "hold"
  >(null);
  const [dischargeDate, setDischargeDate] = useState("");
  const [dischargeNote, setDischargeNote] = useState("");
  const [dischargeReason, setDischargeReason] = useState("completed");
  const [holdReason, setHoldReason] = useState("hospitalized");
  const [holdNote, setHoldNote] = useState("");

  const load = useCallback(async () => {
    try {
      const [eps, agencies, cols] = await Promise.all([
        fetchEpisodes(user, patientId),
        fetchMyAgencies(user).catch(() => [] as ApiMyAgency[]),
        listClinicians(user).catch(() => [] as ApiUser[]),
      ]);
      setEpisodes(eps);
      setMyAgencies(agencies);
      setColleagues(cols);
      setLoadError("");
    } catch {
      setLoadError(
        "Couldn't load this patient's episodes — check the connection.",
      );
    }
    try {
      const from = new Date(Date.now() - 60 * 24 * 3600 * 1000);
      const to = new Date(Date.now() + 120 * 24 * 3600 * 1000);
      const rows = await listAppointments(
        user,
        from.toISOString(),
        to.toISOString(),
        { patientId },
      );
      setSchedule(rows);
    } catch {
      setSchedule([]);
    }
  }, [user, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The live episode: active or on hold (a held episode still
  // owns the patient — addendum 2026-11-03).
  const live = useMemo(
    () => (episodes ?? []).find((e) => e.status !== "discharged") ?? null,
    [episodes],
  );
  const history = useMemo(
    () => (episodes ?? []).filter((e) => e.status === "discharged"),
    [episodes],
  );
  const onHold = live?.status === "on_hold";

  const iAmPrimary =
    !!live && !!me && String(me.id) === String(live.primary_user_id);
  const iAmCaseManager =
    !!live &&
    !!me &&
    live.case_manager_user_id != null &&
    String(me.id) === String(live.case_manager_user_id);
  const canManage =
    iAmPrimary ||
    iAmCaseManager ||
    isManagerRole(me) ||
    (!!me && (me.role === "admin" || me.role === "developer"));

  const currentMembers = useMemo(
    () => (live?.members ?? []).filter((m) => !m.removed_at),
    [live],
  );
  const addableColleagues = useMemo(() => {
    const onTeam = new Set(currentMembers.map((m) => String(m.user_id)));
    return colleagues.filter(
      (c) => c.active && !onTeam.has(String(c.id)),
    );
  }, [colleagues, currentMembers]);

  const now = Date.now();
  const upcoming = useMemo(
    () =>
      (schedule ?? [])
        .filter((a) => new Date(a.starts_at).getTime() >= now)
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    [schedule, now],
  );
  const recent = useMemo(
    () =>
      (schedule ?? [])
        .filter((a) => new Date(a.starts_at).getTime() < now)
        .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
        .slice(0, 10),
    [schedule, now],
  );

  async function run(fn: () => Promise<void>, failMsg: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (err) {
      const code = (err as ApiRequestError | null)?.code;
      if (code === "EPISODE_ACTIVE") {
        const body = (err as ApiRequestError).body as {
          episode?: {
            agency_name?: string;
            primary_name?: string;
            status?: string;
          };
        } | null;
        setError(
          `This patient already has an active episode at ${body?.episode?.agency_name ?? "another agency"}` +
            (body?.episode?.primary_name
              ? ` (primary: ${body.episode.primary_name})`
              : "") +
            (body?.episode?.status === "on_hold"
              ? " — it's on hold right now"
              : "") +
            " — that agency has to discharge before anyone else can admit.",
        );
      } else if (code === "NOT_ON_TEAM") {
        setError("That clinician isn't on this episode's team.");
      } else if (code === "CANNOT_REMOVE_CASE_MANAGER") {
        setError(
          "They're the case manager — hand case management to someone else on the team first.",
        );
      } else if (code === "EPISODE_ON_HOLD") {
        setError(
          "This episode is on hold — resume it first (or discharge it).",
        );
      } else if (code === "NOT_AGENCY_MEMBER") {
        setError(
          "That clinician doesn't belong to this episode's agency. They can join the agency in Settings → My agencies.",
        );
      } else {
        setError(failMsg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function startEpisode() {
    if (!startAgencyId) return;
    await run(async () => {
      await createEpisode(user, patientId, Number(startAgencyId));
      setNotice("Episode started — you're the primary.");
    }, "Couldn't start the episode.");
  }

  async function doDischarge() {
    if (!live) return;
    await run(async () => {
      await dischargeEpisode(user, live.id, {
        dischargedAt: dischargeDate || undefined,
        note: dischargeNote.trim() || undefined,
        reason: dischargeReason,
      });
      setConfirming(null);
      setDischargeNote("");
      setNotice("Episode discharged. It stays in the history below.");
    }, "Couldn't discharge the episode.");
  }

  async function doRecertify() {
    if (!live) return;
    await run(async () => {
      await recertifyEpisode(user, live.id);
      setConfirming(null);
      setNotice(
        "Recertified — the old episode closed and a new one opened with the same team.",
      );
    }, "Couldn't recertify the episode.");
  }

  async function doHold() {
    if (!live) return;
    await run(async () => {
      await holdEpisode(user, live.id, {
        reason: holdReason,
        note: holdNote.trim() || undefined,
      });
      setConfirming(null);
      setHoldNote("");
      setNotice(
        "Episode on hold — booking is paused until it resumes. Booking a Resumption of Care visit ends the hold.",
      );
    }, "Couldn't put the episode on hold.");
  }

  async function doResume() {
    if (!live) return;
    await run(async () => {
      await resumeEpisode(user, live.id);
      setNotice("Episode resumed — booking is open again.");
    }, "Couldn't resume the episode.");
  }

  async function doAddMember() {
    if (!live || !addUserId) return;
    await run(async () => {
      await addEpisodeMember(user, live.id, {
        userId: addUserId,
        supervisedBy: addSupervisorId || null,
      });
      setAddUserId("");
      setAddSupervisorId("");
      setNotice("Teammate added — the patient is on their list now.");
    }, "Couldn't add that teammate.");
  }

  return (
    <article className="card">
      <div className="card-top">
        <strong>Episode of care</strong>
        {live && (
          <span className="kind-badge">{onHold ? "On hold" : "Active"}</span>
        )}
      </div>

      {loadError && <p className="pin-error">{loadError}</p>}
      {episodes === null && !loadError && (
        <p className="section-note">Loading…</p>
      )}

      {episodes !== null && !live && (
        <>
          <p className="section-note">
            No active episode. One episode at a time covers the whole
            platform — starting one here makes you the primary and
            lets you build the team. You don't need one to work with
            this patient on your own: visits you book without an
            episode are personal, and an episode can start later.
          </p>
          {myAgencies.length === 0 ? (
            <p className="section-note">
              Join an agency first (Settings → My agencies) — episodes
              are opened under an agency.
            </p>
          ) : (
            <div className="flag-actions">
              <select
                value={startAgencyId}
                onChange={(e) => setStartAgencyId(e.target.value)}
                aria-label="Agency for the new episode"
              >
                <option value="">Choose an agency…</option>
                {myAgencies.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !startAgencyId}
                onClick={() => void startEpisode()}
              >
                Start episode
              </button>
            </div>
          )}
        </>
      )}

      {live && (
        <>
          <p>
            <strong>{live.agency_name}</strong> · Primary:{" "}
            {live.primary_name}
            {live.case_manager_name &&
              ` · Case manager: ${live.case_manager_name}`}{" "}
            · Admitted {fmtDay(live.admitted_at)}
          </p>
          {onHold && live.current_hold && (
            <p className="section-note">
              <strong>On hold — {holdReasonLabel(live.current_hold.reason)}</strong>{" "}
              since {fmtDay(live.current_hold.started_on)}
              {live.current_hold.note && ` · ${live.current_hold.note}`}.
              New visits can't be booked while held; booking a
              Resumption of Care visit ends the hold.
              {canManage && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => void doResume()}
                  >
                    Resume episode
                  </button>
                </>
              )}
            </p>
          )}
          <h4>Team</h4>
          <ul className="schedule-list">
            {currentMembers.map((m) => {
              const isCaseManager =
                live.case_manager_user_id != null &&
                String(m.user_id) === String(live.case_manager_user_id);
              return (
              <li key={m.user_id} className="schedule-item">
                <span>
                  <strong>{m.user_name}</strong>
                  {m.member_role === "primary" && " · Primary"}
                  {isCaseManager && " · Case manager"}
                  {m.user_position && ` · ${m.user_position}`}
                  {m.supervised_by_name &&
                    ` · supervised by ${m.supervised_by_name}`}
                </span>
                {canManage && (
                  <span className="flag-actions">
                    {m.member_role !== "primary" && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await transferEpisodePrimary(
                              user,
                              live.id,
                              String(m.user_id),
                            );
                            setNotice(`${m.user_name} is the primary now.`);
                          }, "Couldn't change the primary.")
                        }
                      >
                        Make primary
                      </button>
                    )}
                    {!isCaseManager && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await transferCaseManager(
                              user,
                              live.id,
                              String(m.user_id),
                            );
                            setNotice(
                              `${m.user_name} is the case manager now.`,
                            );
                          }, "Couldn't change the case manager.")
                        }
                      >
                        Make case manager
                      </button>
                    )}
                    {m.member_role !== "primary" && !isCaseManager && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await removeEpisodeMember(
                              user,
                              live.id,
                              String(m.user_id),
                            );
                            setNotice(`${m.user_name} left the team.`);
                          }, "Couldn't remove that teammate.")
                        }
                      >
                        Remove
                      </button>
                    )}
                  </span>
                )}
              </li>
              );
            })}
          </ul>

          {canManage && (
            <>
              <div className="flag-actions">
                <select
                  value={addUserId}
                  onChange={(e) => setAddUserId(e.target.value)}
                  aria-label="Colleague to add to the team"
                >
                  <option value="">Add a teammate…</option>
                  {addableColleagues.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.fname} {c.lname}
                      {c.position ? ` · ${c.position}` : ""}
                    </option>
                  ))}
                </select>
                <select
                  value={addSupervisorId}
                  onChange={(e) => setAddSupervisorId(e.target.value)}
                  aria-label="Supervised by (optional)"
                >
                  <option value="">Supervised by (optional)</option>
                  {currentMembers.map((m) => (
                    <option key={m.user_id} value={String(m.user_id)}>
                      {m.user_name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || !addUserId}
                  onClick={() => void doAddMember()}
                >
                  Add
                </button>
              </div>

              {confirming === null && (
                <div className="flag-actions">
                  {!onHold && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => setConfirming("hold")}
                    >
                      Put on hold
                    </button>
                  )}
                  {!onHold && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => setConfirming("recertify")}
                    >
                      Recertify
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => {
                      setDischargeDate(
                        new Date().toISOString().slice(0, 10),
                      );
                      setConfirming("discharge");
                    }}
                  >
                    Discharge episode
                  </button>
                </div>
              )}
              {confirming === "hold" && (
                <div className="csv-import-panel">
                  <p className="section-note">
                    Put this episode on hold? The patient stays with{" "}
                    {live.agency_name} — no other agency can admit —
                    but new visits can't be booked until it resumes.
                  </p>
                  <label>
                    Reason
                    <select
                      value={holdReason}
                      onChange={(e) => setHoldReason(e.target.value)}
                    >
                      {HOLD_REASONS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Note (optional)
                    <input
                      type="text"
                      value={holdNote}
                      onChange={(e) => setHoldNote(e.target.value)}
                      placeholder="e.g. St. Mary Hospital, expected back Friday"
                    />
                  </label>
                  <div className="flag-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void doHold()}
                    >
                      Put on hold
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {confirming === "recertify" && (
                <div className="csv-import-panel">
                  <p className="section-note">
                    Close this episode and open the next certification
                    period at {live.agency_name}, with the same team?
                  </p>
                  <div className="flag-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void doRecertify()}
                    >
                      Close &amp; reopen
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {confirming === "discharge" && (
                <div className="csv-import-panel">
                  <label>
                    Reason
                    <select
                      value={dischargeReason}
                      onChange={(e) => setDischargeReason(e.target.value)}
                    >
                      {DISCHARGE_REASONS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Discharge date
                    <input
                      type="date"
                      value={dischargeDate}
                      onChange={(e) => setDischargeDate(e.target.value)}
                    />
                  </label>
                  <label>
                    Note (optional)
                    <input
                      type="text"
                      value={dischargeNote}
                      onChange={(e) => setDischargeNote(e.target.value)}
                      placeholder="e.g. Goals met; transferred to outpatient"
                    />
                  </label>
                  <div className="flag-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void doDischarge()}
                    >
                      Discharge
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {notice && <p className="section-note">{notice}</p>}
      {error && <p className="pin-error">{error}</p>}

      {history.length > 0 && (
        <>
          <h4>History</h4>
          <ul className="schedule-list">
            {history.map((e) => (
              <li key={e.id} className="schedule-item">
                <span>
                  <strong>{e.agency_name}</strong> · {fmtDay(e.admitted_at)}{" "}
                  → {fmtDay(e.discharged_at)} · Primary: {e.primary_name}
                  {dischargeReasonLabel(e.discharge_reason) &&
                    ` · ${dischargeReasonLabel(e.discharge_reason)}`}
                  {e.discharge_note && ` · ${e.discharge_note}`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>Patient schedule — all visits</h4>
      {schedule === null ? (
        <p className="section-note">Loading…</p>
      ) : upcoming.length === 0 && recent.length === 0 ? (
        <p className="section-note">No visits on record.</p>
      ) : (
        <>
          {upcoming.length > 0 && (
            <ul className="schedule-list">
              {upcoming.map((a) => (
                <li key={a.id} className="schedule-item">
                  <span className="agenda-time">{fmtVisit(a)}</span>
                  <span>
                    <strong>{a.category_name}</strong> —{" "}
                    {a.provider_name ?? "Unassigned"} · {a.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {recent.length > 0 && (
            <>
              <p className="section-note">Recent</p>
              <ul className="schedule-list">
                {recent.map((a) => (
                  <li key={a.id} className="schedule-item">
                    <span className="agenda-time">{fmtVisit(a)}</span>
                    <span>
                      <strong>{a.category_name}</strong> —{" "}
                      {a.provider_name ?? "Unassigned"} · {a.status}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </article>
  );
}
