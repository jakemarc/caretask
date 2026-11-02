// Expenses view (2026-11-01, Jake's spec) — Record → Expenses.
//
// One expense report per clinician per period (usually a
// month). During the month the owner adds mileage for drives
// between patient homes plus non-mileage expense lines; the
// home↔home-office commute is added as commute legs and
// deducted per day by the API (reimbursable = driven −
// commute, floored at zero). Drafts stay editable; the owner
// submits for payment; a manager approves / sends back /
// marks paid with the manager PIN. Previous reports stay
// listed for viewing and printing.
//
// Mileage entry (Jake's form spec): each address is typed
// with autocomplete OR filled from the phone's GPS with the
// nearest patient home (a confirm-first suggestion — the
// clinician sees whose home it picked and can retype). Road
// miles come from routing (tollway vs no-tolls figures both
// shown and stored); the "took the tollway" checkbox makes
// the toll route's miles the leg's miles even when longer;
// miles stay hand-correctable. Saving a leg chains the next
// leg's start to this leg's end.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import {
  ArrowLeft,
  Check,
  LocateFixed,
  Plus,
  Printer,
  Receipt,
  Send,
  Trash2,
  Undo2,
} from "lucide-react";
import AddressAutocomplete, {
  type SuggestedAddress,
} from "./AddressAutocomplete";
import type { PersonUnderCare } from "../lib/demoData";
import {
  addExpenseLine,
  addMileageEntry,
  approveExpenseReport,
  createExpenseReport,
  deleteExpenseLine,
  deleteExpenseReport,
  deleteMileageEntry,
  getExpenseReport,
  listExpenseReports,
  payExpenseReport,
  rejectExpenseReport,
  reportLabel,
  routeMileage,
  submitExpenseReport,
  type ExpenseReport,
  type ReportDetail,
} from "../lib/expensesApi";
import type { ApiRequestError } from "../lib/expensesApi";

const CATEGORIES: { value: string; label: string }[] = [
  { value: "parking", label: "Parking" },
  { value: "tolls", label: "Tolls" },
  { value: "medical_supplies", label: "Medical supplies" },
  { value: "office_supplies", label: "Office supplies" },
  { value: "meals", label: "Meals" },
  { value: "travel", label: "Travel" },
  { value: "lodging", label: "Lodging" },
  { value: "phone_internet", label: "Phone / internet" },
  { value: "training", label: "Training" },
  { value: "licenses", label: "Licenses" },
  { value: "mileage", label: "Mileage (hand-entered)" },
  { value: "other", label: "Other" },
];

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function monthPeriod(monthValue: string): { start: string; end: string } {
  const [y, m] = monthValue.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    start: `${y}-${p(m)}-01`,
    end: `${y}-${p(m)}-${p(last)}`,
  };
}

function prettyDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function errText(err: unknown, fallback: string): string {
  const e = err as ApiRequestError | null;
  if (e?.code === "PIN_REQUIRED" || e?.code === "PIN_INVALID") {
    return "That PIN doesn't match an active manager.";
  }
  if (e?.code === "REPORT_LOCKED") {
    return "This report is no longer a draft, so it can't be changed.";
  }
  if (e?.code === "ROUTE_FAILED") {
    return "Routing is unavailable right now — type the miles instead.";
  }
  return fallback;
}

function haversineMi(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

interface Endpoint {
  text: string;
  lat: number | null;
  lng: number | null;
  hint: string;
}

const blankEndpoint: Endpoint = { text: "", lat: null, lng: null, hint: "" };

export default function ExpensesView({
  user,
  people,
  apiConnected,
}: {
  user: User;
  people: PersonUnderCare[];
  apiConnected: boolean;
}) {
  const [reports, setReports] = useState<ExpenseReport[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // New-report form.
  const [month, setMonth] = useState(() => todayStr().slice(0, 7));
  const [newTitle, setNewTitle] = useState("");

  // Mileage form.
  const [mDate, setMDate] = useState(todayStr());
  const [mKind, setMKind] = useState<"business" | "commute">("business");
  const [start, setStart] = useState<Endpoint>(blankEndpoint);
  const [end, setEnd] = useState<Endpoint>(blankEndpoint);
  const [milesToll, setMilesToll] = useState<number | null>(null);
  const [milesNoToll, setMilesNoToll] = useState<number | null>(null);
  const [usedTollway, setUsedTollway] = useState(false);
  const [roundTrip, setRoundTrip] = useState(false);
  const [miles, setMiles] = useState("");
  const [milesTouched, setMilesTouched] = useState(false);
  const [rate, setRate] = useState("");
  const [routing, setRouting] = useState(false);

  // Expense-line form.
  const [xDate, setXDate] = useState(todayStr());
  const [xCategory, setXCategory] = useState("parking");
  const [xDesc, setXDesc] = useState("");
  const [xAmount, setXAmount] = useState("");

  // Lifecycle.
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [pin, setPin] = useState("");
  const [paymentRef, setPaymentRef] = useState("");

  const loadReports = useCallback(async () => {
    try {
      setReports(await listExpenseReports(user));
    } catch {
      setReports([]);
      setError("Couldn't load expense reports from the API.");
    }
  }, [user]);

  const loadDetail = useCallback(
    async (id: number) => {
      try {
        setDetail(await getExpenseReport(user, id));
      } catch {
        setError("Couldn't load that report.");
      }
    },
    [user],
  );

  useEffect(() => {
    if (apiConnected) void loadReports();
  }, [apiConnected, loadReports]);

  useEffect(() => {
    if (selectedId !== null && apiConnected) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, apiConnected, loadDetail]);

  const geocodedPeople = useMemo(
    () =>
      people.filter(
        (p) =>
          typeof p.latitude === "number" && typeof p.longitude === "number",
      ),
    [people],
  );

  if (!apiConnected) {
    return (
      <section>
        <h1>Expenses</h1>
        <p className="exp-notice">
          Expense reports are stored in the CareTask database — they can't
          load while the API is unreachable.
        </p>
      </section>
    );
  }

  const report = detail?.report ?? null;
  const isDraft = report?.status === "draft";

  // The final miles for the leg being entered, from the chosen
  // route figure — unless the clinician typed miles by hand.
  function applyRouteMiles(
    toll: number | null,
    noToll: number | null,
    tollway: boolean,
    rt: boolean,
  ) {
    if (milesTouched) return;
    const base = tollway && toll !== null ? toll : (noToll ?? toll);
    if (base !== null) setMiles(String(Math.round(base * (rt ? 2 : 1) * 100) / 100));
  }

  async function handleRoute() {
    if (start.lat === null || start.lng === null || end.lat === null || end.lng === null) {
      setError("Both addresses need a map location first — pick a suggestion or use the GPS button.");
      return;
    }
    setRouting(true);
    setError("");
    try {
      const r = await routeMileage(user, {
        start_lat: start.lat,
        start_lng: start.lng,
        end_lat: end.lat,
        end_lng: end.lng,
      });
      setMilesToll(r.miles_toll);
      setMilesNoToll(r.miles_no_toll);
      setMilesTouched(false);
      applyRouteMiles(r.miles_toll, r.miles_no_toll, usedTollway, roundTrip);
    } catch (err) {
      setError(errText(err, "Couldn't calculate road miles."));
    } finally {
      setRouting(false);
    }
  }

  function fillFromGps(which: "start" | "end") {
    const setter = which === "start" ? setStart : setEnd;
    if (!("geolocation" in navigator)) {
      setter((e) => ({ ...e, hint: "This device has no GPS location available." }));
      return;
    }
    setter((e) => ({ ...e, hint: "Finding your location…" }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        let best: { person: PersonUnderCare; dist: number } | null = null;
        for (const p of geocodedPeople) {
          const dist = haversineMi(here, {
            lat: p.latitude as number,
            lng: p.longitude as number,
          });
          if (!best || dist < best.dist) best = { person: p, dist };
        }
        if (best && best.dist <= 25) {
          const p = best.person;
          const addr = [p.street, p.city, p.state, p.postalCode]
            .filter(Boolean)
            .join(", ");
          setter({
            text: addr || p.name,
            lat: p.latitude as number,
            lng: p.longitude as number,
            hint: `Nearest patient home: ${p.name} (~${best.dist.toFixed(1)} mi away). Check it's the right home — you can retype the address.`,
          });
        } else {
          setter({
            text: "",
            lat: here.lat,
            lng: here.lng,
            hint: "No patient home near your current location — type the address; your GPS position is saved for routing.",
          });
        }
      },
      () => setter((e) => ({ ...e, hint: "Couldn't get your location. Type the address instead." })),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  function endpointFromSuggested(s: SuggestedAddress): Endpoint {
    const text = [s.street, s.city, s.state, s.postal_code]
      .filter(Boolean)
      .join(", ");
    return { text, lat: s.latitude, lng: s.longitude, hint: "" };
  }

  async function handleAddMileage(e: React.FormEvent) {
    e.preventDefault();
    if (!report) return;
    const milesNum = Number(miles);
    if (!miles || Number.isNaN(milesNum) || milesNum < 0) {
      setError("Enter the trip miles (calculate them or type them).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await addMileageEntry(user, report.id, {
        entry_date: mDate,
        entry_kind: mKind,
        start_address: start.text || null,
        end_address: end.text || null,
        start_lat: start.lat,
        start_lng: start.lng,
        end_lat: end.lat,
        end_lng: end.lng,
        miles_toll: milesToll,
        miles_no_toll: milesNoToll,
        used_tollway: usedTollway,
        round_trip: roundTrip,
        business_miles: milesNum,
        rate_per_mile: rate ? Number(rate) : null,
      });
      // Chain: the next leg starts where this one ended.
      setStart(end);
      setEnd(blankEndpoint);
      setMilesToll(null);
      setMilesNoToll(null);
      setMiles("");
      setMilesTouched(false);
      setUsedTollway(false);
      setRoundTrip(false);
      await loadDetail(report.id);
    } catch (err) {
      setError(errText(err, "Couldn't save that mileage entry."));
    } finally {
      setBusy(false);
    }
  }

  async function handleAddExpense(e: React.FormEvent) {
    e.preventDefault();
    if (!report) return;
    const dollars = Number(xAmount);
    if (!xAmount || Number.isNaN(dollars) || dollars < 0) {
      setError("Enter the expense amount.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await addExpenseLine(user, report.id, {
        expense_date: xDate,
        category: xCategory,
        description: xDesc || null,
        amount_cents: Math.round(dollars * 100),
      });
      setXDesc("");
      setXAmount("");
      await loadDetail(report.id);
    } catch (err) {
      setError(errText(err, "Couldn't save that expense."));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateReport(e: React.FormEvent) {
    e.preventDefault();
    const { start: s, end: en } = monthPeriod(month);
    setBusy(true);
    setError("");
    try {
      const created = await createExpenseReport(user, {
        period_start: s,
        period_end: en,
        title: newTitle.trim() || undefined,
      });
      setNewTitle("");
      await loadReports();
      setSelectedId(created.id);
    } catch (err) {
      setError(errText(err, "Couldn't create the report."));
    } finally {
      setBusy(false);
    }
  }

  async function lifecycle(action: "submit" | "approve" | "reject" | "pay") {
    if (!report) return;
    setBusy(true);
    setError("");
    try {
      if (action === "submit") await submitExpenseReport(user, report.id);
      if (action === "approve") await approveExpenseReport(user, report.id, pin);
      if (action === "reject") await rejectExpenseReport(user, report.id, pin);
      if (action === "pay") await payExpenseReport(user, report.id, pin, paymentRef);
      setConfirmSubmit(false);
      setPin("");
      setPaymentRef("");
      await Promise.all([loadReports(), loadDetail(report.id)]);
    } catch (err) {
      setError(errText(err, "That action didn't go through."));
    } finally {
      setBusy(false);
    }
  }

  function handlePrint() {
    if (!detail || !report) return;
    const rows = detail.days
      .map(
        (d) => `
        <h3>${prettyDate(d.date)}</h3>
        <table>${d.entries
          .map(
            (en) => `<tr><td>${en.entry_kind === "commute" ? "Commute" : "Drive"}</td><td>${en.start_address ?? ""} → ${en.end_address ?? ""}</td><td class="n">${en.business_miles} mi${en.used_tollway ? " (tollway)" : ""}${en.round_trip ? " (round trip)" : ""}</td></tr>`,
          )
          .join("")}
        <tr class="tot"><td colspan="2">Driven ${d.driven_miles} − Commute ${d.commute_miles} = Reimbursable</td><td class="n">${d.reimbursable_miles} mi</td></tr></table>`,
      )
      .join("");
    const lines = detail.expenses.length
      ? `<h3>Other expenses</h3><table>${detail.expenses
          .map(
            (x) => `<tr><td>${prettyDate(x.expense_date)}</td><td>${x.category.replace(/_/g, " ")}</td><td>${x.description ?? ""}</td><td class="n">${money(x.amount_cents)}</td></tr>`,
          )
          .join("")}</table>`
      : "";
    const html = `<!DOCTYPE html><html><head><title>${reportLabel(report)}</title>
      <style>body{font-family:system-ui,sans-serif;margin:32px;color:#14232b}table{width:100%;border-collapse:collapse;margin:6px 0 14px}td{border-bottom:1px solid #ddd;padding:5px 8px;font-size:13px}.n{text-align:right;white-space:nowrap}.tot td{font-weight:600;border-top:2px solid #999}h3{margin:16px 0 4px}</style></head>
      <body><h2>${reportLabel(report)}</h2>
      <p>${report.owner_name ?? ""} · ${report.period_start} to ${report.period_end} · Status: ${report.status}</p>
      ${rows}${lines}
      <p><strong>Total reimbursable miles:</strong> ${detail.total_reimbursable_miles} mi<br>
      <strong>Mileage:</strong> ${money(detail.mileage_amount_cents)} · <strong>Other expenses:</strong> ${money(detail.expenses_amount_cents)} · <strong>Total:</strong> ${money(detail.total_amount_cents)}</p>
      </body></html>`;
    const w = window.open("", "_blank");
    if (w) {
      w.document.write(html);
      w.document.close();
      w.focus();
      w.print();
    }
  }

  // ---------- list view ----------
  if (selectedId === null) {
    return (
      <section>
        <div className="page-head">
          <h1>Expenses</h1>
        </div>
        {error && <p className="exp-error">{error}</p>}
        <form className="exp-new" onSubmit={handleCreateReport}>
          <label>
            Month
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              required
            />
          </label>
          <label className="exp-grow">
            Name (optional)
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="October mileage – CenterWell"
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            <Plus size={16} /> New report
          </button>
        </form>
        {reports === null ? (
          <p>Loading…</p>
        ) : reports.length === 0 ? (
          <p className="exp-notice">
            No expense reports yet. Create one for this month and add mileage
            as you drive.
          </p>
        ) : (
          <div className="exp-list">
            {reports.map((r) => (
              <button
                key={r.id}
                type="button"
                className="exp-row"
                onClick={() => setSelectedId(r.id)}
              >
                <span className="exp-row-main">
                  <strong>{reportLabel(r)}</strong>
                  <span className="exp-row-sub">
                    {r.period_start} → {r.period_end}
                    {r.owner_name ? ` · ${r.owner_name}` : ""}
                  </span>
                </span>
                <span className={`exp-status exp-status-${r.status}`}>
                  {r.status}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    );
  }

  // ---------- detail view ----------
  return (
    <section>
      <button
        type="button"
        className="btn btn-ghost exp-back"
        onClick={() => {
          setSelectedId(null);
          setDetail(null);
          setError("");
        }}
      >
        <ArrowLeft size={16} /> Expense reports
      </button>
      {!detail || !report ? (
        <p>Loading…</p>
      ) : (
        <>
          <div className="page-head">
            <h1>{reportLabel(report)}</h1>
            <span className={`exp-status exp-status-${report.status}`}>
              {report.status}
            </span>
          </div>
          <p className="exp-sub">
            {report.period_start} → {report.period_end}
            {report.owner_name ? ` · ${report.owner_name}` : ""}
            {report.payment_ref ? ` · Payment ref ${report.payment_ref}` : ""}
          </p>
          {error && <p className="exp-error">{error}</p>}

          <div className="stat-grid">
            <div className="stat-card">
              <Receipt size={20} className="stat-icon" />
              <p className="stat-value">{detail.total_reimbursable_miles} mi</p>
              <p className="stat-label">Reimbursable miles</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{money(detail.mileage_amount_cents)}</p>
              <p className="stat-label">Mileage</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{money(detail.expenses_amount_cents)}</p>
              <p className="stat-label">Other expenses</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{money(detail.total_amount_cents)}</p>
              <p className="stat-label">Report total</p>
            </div>
          </div>

          {detail.days.length === 0 && detail.expenses.length === 0 && (
            <p className="exp-notice">
              Nothing in this report yet — add your first drive below.
            </p>
          )}

          {detail.days.map((d) => (
            <article key={d.date} className="exp-day">
              <h3>{prettyDate(d.date)}</h3>
              {d.entries.map((en) => (
                <div key={en.id} className="exp-entry">
                  <span
                    className={
                      en.entry_kind === "commute"
                        ? "exp-kind exp-kind-commute"
                        : "exp-kind"
                    }
                  >
                    {en.entry_kind === "commute" ? "Commute" : "Drive"}
                  </span>
                  <span className="exp-entry-route">
                    {en.start_address || "—"} → {en.end_address || "—"}
                    {en.used_tollway && (
                      <span className="exp-badge">tollway</span>
                    )}
                    {en.round_trip && (
                      <span className="exp-badge">round trip</span>
                    )}
                  </span>
                  <span className="exp-entry-miles">
                    {en.business_miles} mi
                    {en.rate_per_mile !== null &&
                      ` @ $${en.rate_per_mile}`}
                  </span>
                  {isDraft && (
                    <button
                      type="button"
                      className="btn btn-ghost exp-del"
                      title="Remove entry"
                      onClick={async () => {
                        await deleteMileageEntry(user, report.id, en.id);
                        await loadDetail(report.id);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              ))}
              <p className="exp-day-total">
                Driven {d.driven_miles} − commute {d.commute_miles} ={" "}
                <strong>{d.reimbursable_miles} mi reimbursable</strong>
              </p>
            </article>
          ))}

          {detail.expenses.length > 0 && (
            <article className="exp-day">
              <h3>Other expenses</h3>
              {detail.expenses.map((x) => (
                <div key={x.id} className="exp-entry">
                  <span className="exp-kind">
                    {CATEGORIES.find((c) => c.value === x.category)?.label ??
                      x.category}
                  </span>
                  <span className="exp-entry-route">
                    {prettyDate(x.expense_date)}
                    {x.description ? ` · ${x.description}` : ""}
                  </span>
                  <span className="exp-entry-miles">{money(x.amount_cents)}</span>
                  {isDraft && (
                    <button
                      type="button"
                      className="btn btn-ghost exp-del"
                      title="Remove expense"
                      onClick={async () => {
                        await deleteExpenseLine(user, report.id, x.id);
                        await loadDetail(report.id);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              ))}
            </article>
          )}

          {isDraft && (
            <>
              <form className="exp-form" onSubmit={handleAddMileage}>
                <h3>Add mileage</h3>
                <div className="exp-form-grid">
                  <label>
                    Date
                    <input
                      type="date"
                      value={mDate}
                      onChange={(e) => setMDate(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Type
                    <select
                      value={mKind}
                      onChange={(e) =>
                        setMKind(e.target.value as "business" | "commute")
                      }
                    >
                      <option value="business">Drive between homes</option>
                      <option value="commute">
                        Commute (home ↔ home office)
                      </option>
                    </select>
                  </label>
                </div>
                {(["start", "end"] as const).map((which) => {
                  const ep = which === "start" ? start : end;
                  const setter = which === "start" ? setStart : setEnd;
                  return (
                    <div key={which} className="exp-addr">
                      <div className="exp-addr-field">
                        <span className="exp-addr-label">
                          {which === "start" ? "From" : "To"}
                        </span>
                        <AddressAutocomplete
                          value={ep.text}
                          onChange={(v) =>
                            setter({ text: v, lat: null, lng: null, hint: "" })
                          }
                          onSelectAddress={(s) =>
                            setter(endpointFromSuggested(s))
                          }
                        />
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => fillFromGps(which)}
                        title="Use the nearest patient home from my location"
                      >
                        <LocateFixed size={15} /> Nearest home
                      </button>
                      {ep.hint && <p className="exp-hint">{ep.hint}</p>}
                    </div>
                  );
                })}
                <div className="exp-form-grid">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleRoute}
                    disabled={routing}
                  >
                    {routing ? "Calculating…" : "Calculate road miles"}
                  </button>
                  <span className="exp-routes">
                    {milesToll !== null && `Tollway route: ${milesToll} mi`}
                    {milesToll !== null && milesNoToll !== null && " · "}
                    {milesNoToll !== null && `No tolls: ${milesNoToll} mi`}
                    {milesToll === null && milesNoToll === null &&
                      "Pick both addresses, then calculate — or type the miles."}
                  </span>
                </div>
                <div className="exp-form-grid">
                  <label className="exp-check">
                    <input
                      type="checkbox"
                      checked={usedTollway}
                      onChange={(e) => {
                        setUsedTollway(e.target.checked);
                        applyRouteMiles(
                          milesToll,
                          milesNoToll,
                          e.target.checked,
                          roundTrip,
                        );
                      }}
                    />
                    I took the tollway
                  </label>
                  <label className="exp-check">
                    <input
                      type="checkbox"
                      checked={roundTrip}
                      onChange={(e) => {
                        setRoundTrip(e.target.checked);
                        applyRouteMiles(
                          milesToll,
                          milesNoToll,
                          usedTollway,
                          e.target.checked,
                        );
                      }}
                    />
                    Round trip
                  </label>
                  <label>
                    Miles
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={miles}
                      onChange={(e) => {
                        setMiles(e.target.value);
                        setMilesTouched(true);
                      }}
                      required
                    />
                  </label>
                  <label>
                    Rate $/mi (optional)
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      value={rate}
                      onChange={(e) => setRate(e.target.value)}
                      placeholder="0.70"
                    />
                  </label>
                </div>
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  <Plus size={16} /> Add drive
                </button>
              </form>

              <form className="exp-form" onSubmit={handleAddExpense}>
                <h3>Add an expense</h3>
                <div className="exp-form-grid">
                  <label>
                    Date
                    <input
                      type="date"
                      value={xDate}
                      onChange={(e) => setXDate(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Category
                    <select
                      value={xCategory}
                      onChange={(e) => setXCategory(e.target.value)}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="exp-grow">
                    Description
                    <input
                      type="text"
                      value={xDesc}
                      onChange={(e) => setXDesc(e.target.value)}
                      placeholder="Parking at the hospital"
                    />
                  </label>
                  <label>
                    Amount $
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={xAmount}
                      onChange={(e) => setXAmount(e.target.value)}
                      required
                    />
                  </label>
                </div>
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  <Plus size={16} /> Add expense
                </button>
              </form>
            </>
          )}

          <div className="exp-actions">
            <button type="button" className="btn btn-secondary" onClick={handlePrint}>
              <Printer size={16} /> Print report
            </button>
            {isDraft &&
              (confirmSubmit ? (
                <>
                  <span>Submit this report for payment?</span>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => lifecycle("submit")}
                  >
                    <Check size={16} /> Yes, submit
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setConfirmSubmit(false)}
                  >
                    Keep editing
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setConfirmSubmit(true)}
                >
                  <Send size={16} /> Submit for payment
                </button>
              ))}
            {isDraft && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={async () => {
                  await deleteExpenseReport(user, report.id);
                  setSelectedId(null);
                  await loadReports();
                }}
              >
                <Trash2 size={16} /> Delete report
              </button>
            )}
          </div>

          {(report.status === "submitted" || report.status === "approved") && (
            <div className="exp-manager">
              <h3>Manager review</h3>
              <div className="exp-form-grid">
                <label>
                  Manager PIN
                  <input
                    type="password"
                    inputMode="numeric"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    placeholder="PIN"
                  />
                </label>
                {report.status === "approved" && (
                  <label className="exp-grow">
                    Payment reference (optional)
                    <input
                      type="text"
                      value={paymentRef}
                      onChange={(e) => setPaymentRef(e.target.value)}
                      placeholder="ACH-1001"
                    />
                  </label>
                )}
              </div>
              {report.status === "submitted" ? (
                <div className="exp-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || !pin}
                    onClick={() => lifecycle("approve")}
                  >
                    <Check size={16} /> Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || !pin}
                    onClick={() => lifecycle("reject")}
                  >
                    <Undo2 size={16} /> Send back to draft
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !pin}
                  onClick={() => lifecycle("pay")}
                >
                  <Check size={16} /> Mark paid
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
