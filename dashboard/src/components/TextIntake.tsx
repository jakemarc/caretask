import { useState } from "react";
import type { ContactCandidate } from "../lib/googleContacts";
import {
  parseIntakeText,
  type ExtractedIntake,
} from "../lib/photoExtract";

interface Props {
  onApply: (candidate: ContactCandidate, referrer: string) => void;
  onClose: () => void;
}

// Paste-anything intake (Jake 2026-11-03 — it
// replaces Add by photo on the Add Patient form): the clinician
// pastes raw text copied from a referral, an email, or another
// system, and the same sifter that powered the photo reader
// (lib/photoExtract) sorts it into fields for review. All
// local: the pasted text is never uploaded or saved, and
// nothing reaches the form until "Use these details" is
// clicked — where every field can still be checked and edited
// before saving.
export default function TextIntake({ onApply, onClose }: Props) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ExtractedIntake | null>(null);

  const c = result?.candidate;
  const summary: Array<[string, string]> = c
    ? ([
        ["Name", c.displayName],
        ["Date of birth", c.dob],
        ["Sex", c.sex],
        ["Cell phone", c.phoneCell],
        ["Home phone", c.phoneHome],
        ["Email", c.email],
        [
          "Address",
          [c.street, c.city, c.state, c.postalCode]
            .filter(Boolean)
            .join(", "),
        ],
        ["Referrer", result.referrer],
      ].filter(([, v]) => !!v) as Array<[string, string]>)
    : [];

  return (
    <div className="photo-intake text-intake">
      <div className="card-top">
        <strong>Paste</strong>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="section-note">
        Paste text copied from a referral, an email, or the other
        system, and CareTask will sift it into the form below.
        Everything happens <strong>on this device</strong> — the
        pasted text is never uploaded or saved. Labeled lines
        (Name:, DOB:, Phone:) read best. Check every field before
        saving.
      </p>
      <textarea
        className="text-intake-text"
        rows={9}
        value={text}
        placeholder="Paste text here"
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          setResult(v.trim() ? parseIntakeText(v) : null);
        }}
      />
      {text.trim() && result && (
        <div className="photo-intake-result">
          {summary.length > 0 ? (
            <>
              <p className="card-meta">
                Found: {result.found.join(" · ")}
              </p>
              <dl className="merge-facts">
                {summary.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="flag-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onApply(result.candidate, result.referrer)}
                >
                  Use these details
                </button>
              </div>
            </>
          ) : (
            <p className="section-note">
              Nothing recognizable in that text yet — labeled lines
              read best (Name:, DOB:, Phone:, Address:), or enter
              the details by hand.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
