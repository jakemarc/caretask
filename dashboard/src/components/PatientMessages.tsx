import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  listPatientMessages,
  sendMessage,
  type ApiMessage,
} from "../lib/patientApi";

// Patient Profile → Messages panel: the patient's chart thread
// (OpenEMR's chart-message pattern). Any staff member can read and
// post; messages posted here attach to the patient and may also be
// addressed to a teammate from the Messages tab.

interface Props {
  user: User;
  patientApiId: string;
}

export default function PatientMessages({ user, patientApiId }: Props) {
  const [msgs, setMsgs] = useState<ApiMessage[] | null>(null);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setMsgs(await listPatientMessages(user, patientApiId));
    } catch {
      setError("Couldn't load this patient's messages.");
    }
  }, [user, patientApiId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post() {
    if (!body.trim()) return;
    setSending(true);
    try {
      await sendMessage(user, {
        patient_id: patientApiId,
        body: body.trim(),
      });
      setBody("");
      await load();
    } catch {
      setError("Couldn't post the message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <article className="card">
      <strong>Messages</strong>
      <p className="card-meta">
        Chart messages for the care team — they live on this
        patient's record.
      </p>
      {error && <p className="pin-error">{error}</p>}
      <div className="card-list">
        {(msgs ?? []).map((m) => (
          <div key={m.id} className="msg-bubble">
            <p className="card-meta">
              <strong>{m.sender_name}</strong> ·{" "}
              {new Date(m.created_at).toLocaleString("en-US")}
              {m.recipient_name ? ` · to ${m.recipient_name}` : ""}
            </p>
            {m.subject && (
              <p>
                <strong>{m.subject}</strong>
              </p>
            )}
            <p>{m.body}</p>
          </div>
        ))}
        {msgs !== null && msgs.length === 0 && (
          <p className="section-note">No chart messages yet.</p>
        )}
        {msgs === null && !error && (
          <p className="section-note">Loading…</p>
        )}
      </div>
      <label>
        Add a chart message
        <textarea
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="e.g. Family called — daughter will be home for Thursday's revisit"
        />
      </label>
      <div className="profile-actions">
        <button
          className="btn btn-primary"
          disabled={sending || !body.trim()}
          onClick={() => void post()}
        >
          {sending ? "Posting…" : "Post to chart"}
        </button>
      </div>
    </article>
  );
}
