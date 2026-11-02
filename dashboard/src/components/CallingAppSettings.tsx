import { useState } from "react";
import {
  getCallingApp,
  setCallingApp,
  type CallingApp,
} from "../lib/phone";

// Settings → Calling app (Jake, 2026-11-02): one saved choice for
// which app every Call button hands the number to — remembered on
// this device, never asked per tap. Only handoff-capable apps are
// offered; the note under the buttons says plainly what each one
// does with the number.

const OPTIONS: Array<{
  id: CallingApp;
  label: string;
  note: string;
}> = [
  {
    id: "phone",
    label: "Phone",
    note: "Calls open in the phone app with the number ready to dial.",
  },
  {
    id: "googlevoice",
    label: "Google Voice",
    note: "Calls open in Google Voice with the number in the dialer — one tap there places the call, and the patient sees your Voice number.",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    note: "Opens the WhatsApp chat for the number; the voice-call button inside is one more tap. The patient needs WhatsApp.",
  },
  {
    id: "facetime",
    label: "FaceTime",
    note: "Hands the number to FaceTime Audio (iPhone, iPad, Mac).",
  },
];

export default function CallingAppSettings() {
  const [app, setApp] = useState<CallingApp>(() => getCallingApp());
  const active = OPTIONS.find((o) => o.id === app) ?? OPTIONS[0];
  return (
    <article className="card">
      <strong>Calling app</strong>
      <p className="card-meta">
        Which app the Call buttons hand the number to. Saved on this
        device — you're never asked per call.
      </p>
      <div className="flag-actions">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            className={
              app === o.id ? "btn btn-primary" : "btn btn-secondary"
            }
            aria-pressed={app === o.id}
            onClick={() => {
              setCallingApp(o.id);
              setApp(o.id);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="section-note">{active.note}</p>
    </article>
  );
}
