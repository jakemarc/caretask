import { useEffect, useRef, useState } from "react";
import type { ContactCandidate } from "../lib/googleContacts";
import { parseIntakeText, type ExtractedIntake } from "../lib/photoExtract";

// Add Patient by photo (Jake, 2026-11-02 — he chose the FREE
// on-device reader). The photo is read with Tesseract.js, which
// runs entirely in the browser on this device: the image never
// leaves the phone, is never uploaded, and is discarded when the
// panel closes. (The OCR engine and its English data download
// once from a CDN — that's program code, not the photo.) The
// extracted fields land in the regular Add Patient form via
// onApply, where they are reviewed and edited before saving;
// nothing saves from here.

interface Props {
  onApply: (candidate: ContactCandidate, referrer: string) => void;
  onClose: () => void;
}

type Phase = "idle" | "reading" | "done" | "error";

export default function PhotoIntake({ onApply, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractedIntake | null>(null);
  const [rawText, setRawText] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function readPhoto(file: File) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setPhase("reading");
    setProgress(0);
    setError("");
    setResult(null);
    try {
      const { createWorker, OEM } = await import("tesseract.js");
      const worker = await createWorker("eng", OEM.LSTM_ONLY, {
        logger: (m) => {
          if (m.status === "recognizing text") {
            setProgress(Math.round(m.progress * 100));
          }
        },
      });
      try {
        const { data } = await worker.recognize(file);
        setRawText(data.text);
        setResult(parseIntakeText(data.text));
        setPhase("done");
      } finally {
        await worker.terminate();
      }
    } catch {
      setError(
        "The photo couldn't be read on this device. Check the connection (the reader downloads once) or enter the details by hand.",
      );
      setPhase("error");
    }
  }

  const c = result?.candidate;
  const summary: Array<[string, string]> = c
    ? [
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
      ].filter(([, v]) => !!v) as Array<[string, string]>
    : [];

  return (
    <div className="photo-intake">
      <div className="card-top">
        <strong>Add by photo</strong>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="section-note">
        Photograph a referral sheet or intake form. The photo is
        read <strong>on this device only</strong> — it is never
        uploaded or saved. Check every field in the form before
        saving; print reads well, handwriting and blur may misread.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void readPhoto(f);
        }}
      />
      <div className="flag-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={phase === "reading"}
          onClick={() => fileRef.current?.click()}
        >
          {phase === "idle" ? "Take or choose a photo" : "Use a different photo"}
        </button>
        {phase === "reading" && (
          <span className="card-meta">Reading… {progress}%</span>
        )}
      </div>
      {previewUrl && (
        <img
          className="photo-intake-preview"
          src={previewUrl}
          alt="The intake sheet you picked"
        />
      )}
      {phase === "error" && <p className="pin-error">{error}</p>}
      {phase === "done" && result && (
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
                  onClick={() => {
                    if (c) onApply(c, result.referrer);
                  }}
                >
                  Use these details
                </button>
              </div>
            </>
          ) : (
            <p className="section-note">
              Nothing usable could be read from that photo — try a
              straighter, well-lit shot, or enter the details by hand.
            </p>
          )}
          <details className="photo-intake-raw">
            <summary>What the reader saw</summary>
            <pre>{rawText}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
