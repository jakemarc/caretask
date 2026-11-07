// Reports → Exports card (Jake, 2026-11-06): the SAP Concur
// mileage CSV export lives here, under Reports, instead of on
// the Mileage page. Pick a period + agency, click Export, and
// the CSV is fetched fresh from the mileage report API and
// downloaded (see src/lib/concurCsv.ts for the file format).
import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { Download } from "lucide-react";
import { fetchAgencies, type ApiAgency } from "../lib/patientApi";
import { fetchMileageReport } from "../lib/expensesApi";
import { downloadConcurCsv } from "../lib/concurCsv";

function todayStr(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function monthRange(monthValue: string): { from: string; to: string } {
  const [y, m] = monthValue.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return {
    from: `${monthValue}-01`,
    to: `${monthValue}-${`${last}`.padStart(2, "0")}`,
  };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function errText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export default function ConcurExportCard({ user }: { user: User }) {
  const [agencies, setAgencies] = useState<ApiAgency[] | null>(null);
  const [mode, setMode] = useState<"month" | "range">("month");
  const [month, setMonth] = useState(() => todayStr().slice(0, 7));
  const [from, setFrom] = useState(() => monthRange(todayStr().slice(0, 7)).from);
  const [to, setTo] = useState(() => monthRange(todayStr().slice(0, 7)).to);
  const [agencyId, setAgencyId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ags = await fetchAgencies(user);
        if (!cancelled) setAgencies(ags.filter((a) => a.active));
      } catch {
        // Agency list is optional — "All agencies" still works.
        if (!cancelled) setAgencies([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const exportCsv = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const range = mode === "month" ? monthRange(month) : { from, to };
      const rep = await fetchMileageReport(user, { ...range, agency_id: agencyId });
      const fallbackRate =
        parseFloat(localStorage.getItem("caretask-mileage-rate") ?? "0.70") || 0.70;
      const stats = downloadConcurCsv(rep, fallbackRate);
      setNotice(
        `Concur CSV downloaded — ${stats.entries} mileage ${stats.entries === 1 ? "entry" : "entries"}, ` +
          `${Math.round(stats.miles * 100) / 100} mi` +
          (stats.expense_count
            ? `, plus ${stats.expense_count} expense ${stats.expense_count === 1 ? "line" : "lines"} (${money(stats.expense_cents)})`
            : "") +
          `, ${money(stats.cents)} total. Personal (commute) legs are excluded.`,
      );
    } catch (err) {
      setError(errText(err, "Could not export the Concur CSV."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card rpt-export">
      <h2>Exports</h2>
      <h3>SAP Concur — Personal Car Mileage</h3>
      <div className="mlg-controls">
        <label>
          Period
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "month" | "range")}
          >
            <option value="month">Month</option>
            <option value="range">Date range</option>
          </select>
        </label>
        {mode === "month" ? (
          <label>
            Month
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
        ) : (
          <>
            <label>
              From
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              To
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        )}
        <label>
          Agency
          <select
            value={agencyId ?? ""}
            onChange={(e) => setAgencyId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">All agencies</option>
            {(agencies ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void exportCsv()}
          disabled={busy}
        >
          <Download size={16} /> {busy ? "Preparing…" : "Export Concur CSV"}
        </button>
      </div>
      {error && <p className="exp-error">{error}</p>}
      {notice && <p className="exp-notice">{notice}</p>}
    </div>
  );
}
