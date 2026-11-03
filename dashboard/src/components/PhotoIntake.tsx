import { useEffect, useRef, useState } from "react";
import type { ContactCandidate } from "../lib/googleContacts";
import {
  parseIntakeOcr,
  type ExtractedIntake,
  type OcrWord,
} from "../lib/photoExtract";

// Add Patient by photo (Jake, 2026-11-02 — he chose the FREE
// on-device reader). The photo is read with Tesseract.js, which
// runs entirely in the browser on this device: the image never
// leaves the phone, is never uploaded, and is discarded when the
// panel closes. (The OCR engine and its English data download
// once from a CDN — that's program code, not the photo.) Before
// reading, the image is cleaned up on a canvas (scaled toward a
// readable size, grayscale + contrast) — still on-device. The
// reader also returns word positions, and the parser uses them
// to read column by column and skip non-patient blocks (an
// agency-information column no longer fills patient fields).
// The extracted fields land in the regular Add Patient form via
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
  const [quality, setQuality] = useState<number | null>(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Clean the photo up for the reader: draw it to a canvas at a
  // readable size (long edge toward ~2200px, never more than
  // 2.5× upscale) in grayscale with a contrast lift. All local.
  async function prepareImage(file: File): Promise<HTMLCanvasElement | File> {
    try {
      const bmp = await createImageBitmap(file);
      const longEdge = Math.max(bmp.width, bmp.height);
      const scale = Math.min(2.5, Math.max(0.5, 2200 / longEdge));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      try {
        ctx.filter = "grayscale(1) contrast(1.12)";
      } catch {
        // Older browsers ignore an unsupported filter — the
        // scaled copy is still worth reading.
      }
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      return canvas;
    } catch {
      return file;
    }
  }

  async function readPhoto(file: File) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setPhase("reading");
    setProgress(0);
    setError("");
    setResult(null);
    setQuality(null);
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
        const image = await prepareImage(file);
        const { data } = await worker.recognize(image, {}, {
          text: true,
          blocks: true,
        });
        const words: OcrWord[] = [];
        for (const b of data.blocks ?? [])
          for (const p of b.paragraphs)
            for (const l of p.lines)
              for (const w of l.words)
                words.push({
                  text: w.text,
                  x0: w.bbox.x0,
                  y0: w.bbox.y0,
                  x1: w.bbox.x1,
                  y1: w.bbox.y1,
                });
        setRawText(data.text);
        setQuality(Math.round(data.confidence));
        setResult(parseIntakeOcr({ text: data.text, words }));
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
          {quality !== null && quality < 75 && (
            <p className="section-note">
              Read quality was low on that photo — a straighter,
              closer, brighter shot (or the printed sheet itself)
              usually reads much better.
            </p>
          )}
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
