// Settings cards (deploy-41): the mileage rate table and the
// expense receipt policy. Both are read-only for clinicians;
// managers/admins maintain them (the API enforces the role —
// the UI only mirrors it for presentation, same discipline as
// the rest of the dashboard). Inline notice/error pattern
// follows HomeOfficeSettings.
import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  createRate,
  fetchPolicy,
  fetchRates,
  updatePolicy,
  type ApiRequestError,
  type ExpensePolicy,
  type MileageRate,
} from "../lib/expensesApi";
import { isManagerRole, useMyStaff } from "../lib/useMyRole";

interface Props {
  user: User;
  apiConnected: boolean;
}

function errText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function errCode(err: unknown): string | undefined {
  return (err as ApiRequestError | null)?.code;
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function rateText(rate: number): string {
  return `$${rate.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0")}`;
}

function rangeText(r: MileageRate): string {
  return r.effective_to
    ? `from ${fmtDay(r.effective_from)} to ${fmtDay(r.effective_to)}`
    : `from ${fmtDay(r.effective_from)} · current`;
}

// ---------- mileage rate table ----------

export function MileageRatesCard({ user, apiConnected }: Props) {
  const me = useMyStaff(user);
  const manager = isManagerRole(me);
  const [rates, setRates] = useState<MileageRate[] | null>(null);
  const [rate, setRate] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setRates(await fetchRates(user));
    } catch (err) {
      setError(errText(err, "Could not load the rate table."));
    }
  }, [user]);

  useEffect(() => {
    if (!apiConnected) return;
    void load();
  }, [apiConnected, load]);

  if (!apiConnected) {
    return (
      <article className="card">
        <strong>Mileage rates</strong>
        <p>
          The mileage rate table needs the API — it can't load while the API
          is unreachable.
        </p>
      </article>
    );
  }

  const add = async () => {
    const value = Number(rate);
    if (!rate || Number.isNaN(value) || value <= 0) {
      setError("Enter a rate above zero.");
      return;
    }
    if (!from) {
      setError("Pick the date this rate takes effect.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await createRate(user, { rate: value, effective_from: from });
      setRate("");
      setFrom("");
      setNotice("Rate added.");
      await load();
    } catch (err) {
      setError(
        errCode(err) === "RATE_DATE_EXISTS"
          ? errText(err, "A rate already starts on that date — pick a different effective date.")
          : errText(err, "Could not add that rate."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card">
      <div className="card-top">
        <strong>Mileage rates</strong>
      </div>
      <p>
        The per-mile rate table. The Mileage page resolves each day's rate
        from this table by date; a day with no rate in effect falls back to
        the clinician's saved rate.
      </p>
      {rates === null && !error && <p className="section-note">Loading…</p>}
      {rates !== null && rates.length === 0 && (
        <p className="section-note">No rates in the table yet.</p>
      )}
      {(rates ?? []).map((r) => (
        <p key={r.id} className="exp-rate-row">
          <strong>{rateText(r.rate)}/mi</strong>
          <span className="section-note">{rangeText(r)}</span>
        </p>
      ))}
      {manager ? (
        <form
          className="add-form"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <h3>Add a rate</h3>
          <div className="form-row">
            <label>
              Rate ($/mi)
              <input
                type="number"
                min="0"
                step="0.001"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </label>
            <label>
              Effective from
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
          </div>
          <div className="flag-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Adding…" : "Add rate"}
            </button>
          </div>
        </form>
      ) : (
        <p className="section-note">
          Rates are maintained by managers — this list is read-only for you.
        </p>
      )}
      {notice && <p className="section-note">{notice}</p>}
      {error && <p className="pin-error">{error}</p>}
    </article>
  );
}

// ---------- expense receipt policy ----------

export function ExpensePolicyCard({ user, apiConnected }: Props) {
  const me = useMyStaff(user);
  const manager = isManagerRole(me);
  const [policy, setPolicy] = useState<ExpensePolicy | null>(null);
  const [require, setRequire] = useState(false);
  const [threshold, setThreshold] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!apiConnected) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await fetchPolicy(user);
        if (cancelled) return;
        setPolicy(p);
        setRequire(p.require_receipts);
        setThreshold(
          p.receipt_threshold_cents === null
            ? ""
            : (p.receipt_threshold_cents / 100).toFixed(2),
        );
      } catch (err) {
        if (!cancelled) setError(errText(err, "Could not load the expense policy."));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiConnected, user]);

  if (!apiConnected) {
    return (
      <article className="card">
        <strong>Expense policy</strong>
        <p>
          The expense receipt policy needs the API — it can't load while the
          API is unreachable.
        </p>
      </article>
    );
  }

  const save = async () => {
    let thresholdCents: number | null = null;
    if (threshold.trim() !== "") {
      const dollars = Number(threshold);
      if (Number.isNaN(dollars) || dollars < 0) {
        setError("Threshold must be a dollar amount, or blank for all lines.");
        return;
      }
      thresholdCents = Math.round(dollars * 100);
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await updatePolicy(user, {
        require_receipts: require,
        receipt_threshold_cents: thresholdCents,
      });
      setPolicy(saved);
      setNotice("Expense policy saved.");
    } catch (err) {
      setError(errText(err, "Could not save the expense policy."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card">
      <div className="card-top">
        <strong>Expense policy</strong>
      </div>
      <p>
        When receipts are required, a report can't be submitted while a line
        at or above the threshold has no receipt attached. Leave the
        threshold blank to require receipts on every line.
      </p>
      {policy === null && !error && <p className="section-note">Loading…</p>}
      {policy !== null && (
        <form
          className="add-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={require}
              disabled={!manager}
              onChange={(e) => setRequire(e.target.checked)}
            />
            Require receipts on expense reports
          </label>
          <label>
            Receipt threshold ($)
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Blank = all lines"
              value={threshold}
              disabled={!manager}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </label>
          {manager ? (
            <div className="flag-actions">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "Saving…" : "Save policy"}
              </button>
            </div>
          ) : (
            <p className="section-note">
              The policy is maintained by managers — these values are
              read-only for you.
            </p>
          )}
        </form>
      )}
      {notice && <p className="section-note">{notice}</p>}
      {error && <p className="pin-error">{error}</p>}
    </article>
  );
}
