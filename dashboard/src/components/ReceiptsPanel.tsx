// Receipt attachments (deploy-41): a paperclip button with a
// count badge that expands inline to the line's receipt list —
// view (blob → object URL), delete, and upload. Shared by the
// mileage day-log legs and the itemized expense lines. Client
// validation mirrors the API's: JPEG / PNG / WebP / PDF only,
// 8 MiB cap (RECEIPT_TYPE_INVALID / RECEIPT_TOO_LARGE);
// REPORT_LOCKED and other API errors surface inline.
import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { Eye, Paperclip, Trash2, Upload, X } from "lucide-react";
import {
  deleteReceipt,
  fetchReceiptBlob,
  listReceipts,
  uploadReceipt,
  type ReceiptMeta,
} from "../lib/expensesApi";

export const RECEIPT_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const RECEIPT_MAX_BYTES = 8 * 1024 * 1024;

function errText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dateText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function ReceiptsPanel({
  user,
  kind,
  lineId,
  initialCount = 0,
  onCountChange,
}: {
  user: User;
  kind: "mileage" | "expense";
  // Null while the line has never been saved — nothing to
  // attach to yet, so the button renders disabled.
  lineId: number | null;
  initialCount?: number;
  onCountChange?: (count: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(initialCount);
  const [receipts, setReceipts] = useState<ReceiptMeta[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCount(initialCount);
  }, [initialCount]);

  const applyCount = (n: number) => {
    setCount(n);
    onCountChange?.(n);
  };

  const load = async () => {
    if (lineId === null) return;
    setError("");
    try {
      const rows = await listReceipts(user, kind, lineId);
      setReceipts(rows);
      applyCount(rows.length);
    } catch (err) {
      setError(errText(err, "Could not load receipts."));
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && receipts === null) void load();
  };

  const view = async (r: ReceiptMeta) => {
    setError("");
    try {
      const blob = await fetchReceiptBlob(user, r.id);
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank", "noopener");
      if (!win) {
        const a = document.createElement("a");
        a.href = url;
        a.download = r.filename;
        a.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      setError(errText(err, "Could not open that receipt."));
    }
  };

  const remove = async (r: ReceiptMeta) => {
    setBusy(true);
    setError("");
    try {
      await deleteReceipt(user, r.id);
      const rows = (receipts ?? []).filter((x) => x.id !== r.id);
      setReceipts(rows);
      applyCount(rows.length);
    } catch (err) {
      setError(errText(err, "Could not delete that receipt."));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file || lineId === null) return;
    if (!RECEIPT_TYPES.includes(file.type)) {
      setError("Receipts must be a JPEG, PNG, or WebP image, or a PDF.");
      return;
    }
    if (file.size > RECEIPT_MAX_BYTES) {
      setError("That receipt is too large — the limit is 8 MiB.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await uploadReceipt(user, kind, lineId, file);
      const rows = [...(receipts ?? []), saved];
      setReceipts(rows);
      applyCount(rows.length);
    } catch (err) {
      setError(errText(err, "Could not upload that receipt."));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <span className="rcpt">
      <button
        type="button"
        className="mlg-ticon rcpt-btn"
        onClick={toggle}
        disabled={lineId === null}
        aria-label={lineId === null ? "Save the line first to attach receipts" : "Receipts"}
        title={
          lineId === null
            ? "Save first — receipts attach to saved lines"
            : `${count} receipt${count === 1 ? "" : "s"} — tap to manage`
        }
      >
        <Paperclip size={15} />
        {count > 0 && <span className="rcpt-badge">{count}</span>}
      </button>
      {open && lineId !== null && (
        <span className="rcpt-panel">
          <span className="rcpt-panel-head">
            <strong>Receipts</strong>
            <button
              type="button"
              className="mlg-ticon"
              onClick={() => setOpen(false)}
              aria-label="Close receipts"
              title="Close"
            >
              <X size={14} />
            </button>
          </span>
          {receipts === null && <span className="mlg-hint">Loading…</span>}
          {receipts !== null && receipts.length === 0 && (
            <span className="mlg-hint">No receipts attached yet.</span>
          )}
          {(receipts ?? []).map((r) => (
            <span key={r.id} className="rcpt-row">
              <span className="rcpt-meta">
                <span className="rcpt-name">{r.filename}</span>
                <span className="mlg-hint">
                  {sizeText(r.size_bytes)} · {dateText(r.created_at)}
                </span>
              </span>
              <button
                type="button"
                className="mlg-ticon"
                onClick={() => void view(r)}
                aria-label={`View ${r.filename}`}
                title="View"
              >
                <Eye size={14} />
              </button>
              <button
                type="button"
                className="mlg-ticon"
                onClick={() => void remove(r)}
                disabled={busy}
                aria-label={`Delete ${r.filename}`}
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </span>
          ))}
          {error && <span className="exp-error rcpt-error">{error}</span>}
          <span className="rcpt-upload">
            <input
              ref={fileRef}
              type="file"
              accept={RECEIPT_ACCEPT}
              className="rcpt-file"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <button
              type="button"
              className="btn btn-small"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              <Upload size={14} /> {busy ? "Working…" : "Upload receipt"}
            </button>
            <span className="mlg-hint">JPEG, PNG, WebP or PDF, up to 8 MiB</span>
          </span>
        </span>
      )}
    </span>
  );
}
