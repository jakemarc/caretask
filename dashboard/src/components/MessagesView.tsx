import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  deleteMessage,
  getMessageThread,
  listMessages,
  markMessageRead,
  sendMessage,
  type ApiMessage,
  type ApiUser,
} from "../lib/patientApi";
import type { PersonUnderCare } from "../lib/demoData";

// Messages tab — Phase 1 messaging (staff direct messages +
// patient-linked chart messages), modeled on OpenEMR's Messages
// center. Everything lives in the API; when it's unreachable the
// tab says so instead of showing local fakes.

interface Props {
  user: User;
  apiConnected: boolean;
  staff: ApiUser[] | null;
  patients: PersonUnderCare[];
  onOpenPatient: (apiId: string) => void;
  onUnreadChange: (count: number) => void;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function MessagesView({
  user,
  apiConnected,
  staff,
  patients,
  onOpenPatient,
  onUnreadChange,
}: Props) {
  const [box, setBox] = useState<"inbox" | "sent">("inbox");
  const [list, setList] = useState<ApiMessage[] | null>(null);
  const [meId, setMeId] = useState<string>("");
  const [notice, setNotice] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [thread, setThread] = useState<ApiMessage[] | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [cRecipient, setCRecipient] = useState("");
  const [cPatient, setCPatient] = useState("");
  const [cSubject, setCSubject] = useState("");
  const [cBody, setCBody] = useState("");
  const [sending, setSending] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiConnected) return;
    try {
      const inbox = await listMessages(user, { unread: true });
      onUnreadChange(inbox.messages.length);
      const out = await listMessages(user, { sent: box === "sent" });
      setList(out.messages);
      setMeId(out.meId);
    } catch {
      setNotice("Couldn't load messages.");
    }
  }, [apiConnected, user, box, onUnreadChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function openThread(m: ApiMessage) {
    setThreadId(m.thread_id);
    setThread(null);
    try {
      let rows = await getMessageThread(user, m.thread_id);
      // Opening a thread marks my unread messages in it as read.
      const mine = rows.filter(
        (x) => x.recipient_id === meId && !x.read_at,
      );
      for (const x of mine) {
        await markMessageRead(user, x.id);
      }
      if (mine.length) {
        rows = await getMessageThread(user, m.thread_id);
        void refresh();
      }
      setThread(rows);
    } catch {
      setNotice("Couldn't open that conversation.");
    }
  }

  async function doSendReply() {
    if (!thread || !replyBody.trim()) return;
    const last = thread[thread.length - 1];
    const other =
      last.recipient_id === meId ? last.sender_id : last.recipient_id;
    setSending(true);
    try {
      await sendMessage(user, {
        recipient_id: other,
        patient_id: last.patient_id,
        thread_id: threadId,
        body: replyBody.trim(),
      });
      setReplyBody("");
      setThread(await getMessageThread(user, threadId!));
      void refresh();
    } catch {
      setNotice("Couldn't send the reply.");
    } finally {
      setSending(false);
    }
  }

  async function doCompose() {
    if (!cBody.trim()) return setNotice("Write a message first.");
    if (!cRecipient && !cPatient)
      return setNotice("Pick a person, a patient, or both.");
    setSending(true);
    try {
      await sendMessage(user, {
        recipient_id: cRecipient || null,
        patient_id: cPatient || null,
        subject: cSubject.trim() || null,
        body: cBody.trim(),
      });
      setComposeOpen(false);
      setCRecipient("");
      setCPatient("");
      setCSubject("");
      setCBody("");
      setNotice("");
      if (box !== "sent") setBox("sent");
      else void refresh();
    } catch {
      setNotice("Couldn't send the message.");
    } finally {
      setSending(false);
    }
  }

  async function doDelete(m: ApiMessage) {
    try {
      await deleteMessage(user, m.id);
      if (thread) setThread(await getMessageThread(user, threadId!));
      void refresh();
    } catch {
      setNotice("Couldn't delete that message.");
    }
  }

  if (!apiConnected) {
    return (
      <section>
        <h1>Messages</h1>
        <div className="card">
          <strong>Message API unreachable</strong>
          <p>
            Messages live in the CareTask database — there's no local
            copy to show while the API is down.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="cal-toolbar">
        <h1>Messages</h1>
        <span className="cal-spacer" />
        <div className="cal-views">
          <button
            className={box === "inbox" ? "btn btn-primary" : "btn"}
            onClick={() => setBox("inbox")}
          >
            Inbox
          </button>
          <button
            className={box === "sent" ? "btn btn-primary" : "btn"}
            onClick={() => setBox("sent")}
          >
            Sent
          </button>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setComposeOpen((v) => !v)}
        >
          + New message
        </button>
      </div>
      {notice && <p className="pin-error">{notice}</p>}

      {composeOpen && (
        <div className="cal-form">
          <h3>New message</h3>
          <div className="form-grid">
            <label>
              To (staff)
              <select
                value={cRecipient}
                onChange={(e) => setCRecipient(e.target.value)}
              >
                <option value="">— nobody (chart note) —</option>
                {(staff ?? [])
                  .filter((s) => s.active)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.fname} {s.lname} — {s.email}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Attach to patient (optional)
              <select
                value={cPatient}
                onChange={(e) => setCPatient(e.target.value)}
              >
                <option value="">— no patient —</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-wide">
              Subject
              <input
                type="text"
                value={cSubject}
                onChange={(e) => setCSubject(e.target.value)}
                placeholder="Optional"
              />
            </label>
            <label className="form-wide">
              Message
              <textarea
                rows={4}
                value={cBody}
                onChange={(e) => setCBody(e.target.value)}
              />
            </label>
          </div>
          <div className="profile-actions">
            <button
              className="btn btn-primary"
              disabled={sending}
              onClick={() => void doCompose()}
            >
              {sending ? "Sending…" : "Send"}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setComposeOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="card-list">
        {(list ?? []).map((m) => (
          <button
            key={m.id}
            className={
              "msg-row" + (m.recipient_id === meId && !m.read_at ? " unread" : "")
            }
            onClick={() => void openThread(m)}
          >
            <span className="msg-who">
              {box === "inbox"
                ? m.sender_name
                : (m.recipient_name ?? "Patient chart")}
            </span>
            <span className="msg-main">
              <strong>{m.subject ?? m.body.slice(0, 60)}</strong>
              <span className="card-meta">
                {" "}
                · {fmtWhen(m.created_at)}
                {m.patient_name ? ` · re: ${m.patient_name}` : ""}
                {m.recipient_id === meId && !m.read_at ? " · unread" : ""}
              </span>
            </span>
          </button>
        ))}
        {list !== null && list.length === 0 && (
          <p className="section-note">
            {box === "inbox" ? "Inbox is empty." : "Nothing sent yet."}
          </p>
        )}
        {list === null && <p className="section-note">Loading…</p>}
      </div>

      {threadId && (
        <div className="cal-form">
          <h3>Conversation</h3>
          {(thread ?? []).map((m) => (
            <div key={m.id} className="msg-bubble">
              <p className="card-meta">
                <strong>{m.sender_name}</strong> ·{" "}
                {new Date(m.created_at).toLocaleString("en-US")}
                {m.patient_name && (
                  <>
                    {" "}
                    · re:{" "}
                    <button
                      className="linklike"
                      onClick={() =>
                        m.patient_id && onOpenPatient(m.patient_id)
                      }
                    >
                      {m.patient_name}
                    </button>
                  </>
                )}
                {m.read_at
                  ? ` · read ${fmtWhen(m.read_at)}`
                  : m.recipient_id
                    ? " · unread"
                    : ""}
              </p>
              {m.subject && (
                <p>
                  <strong>{m.subject}</strong>
                </p>
              )}
              <p>{m.body}</p>
              {m.sender_id === meId && (
                <button
                  className="btn btn-danger"
                  onClick={() => void doDelete(m)}
                >
                  Delete
                </button>
              )}
            </div>
          ))}
          {thread === null && <p className="section-note">Loading…</p>}
          <label>
            Reply
            <textarea
              rows={3}
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
            />
          </label>
          <div className="profile-actions">
            <button
              className="btn btn-primary"
              disabled={sending || !replyBody.trim()}
              onClick={() => void doSendReply()}
            >
              {sending ? "Sending…" : "Send reply"}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setThreadId(null)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
