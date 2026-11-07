// SAP Concur-compatible mileage CSV (Jake, 2026-11-06; moved
// to the Reports view the same day): one row per BILLABLE leg,
// columns named/shaped for Concur Expense's mileage entry +
// flat-file import (Report Name, Transaction Date, Expense
// Type, From/To Location, Distance, Rate, Amount...). Personal
// (commute) legs are excluded — Concur mileage claims are
// business miles only. From/To carry ADDRESSES ONLY — patient
// names never appear in the export (a leg whose endpoint has
// no address on file exports a blank From/To; the Business
// Purpose stays generic on purpose). Amount uses each leg's saved rate
// snapshot, falling back to `fallbackRate` for legs saved
// without one.
//
// Shared builder: performs the download and returns the stats
// so the caller can render its own notice line.
import { expenseCategoryLabel, type MileageReport } from "./expensesApi";

export function downloadConcurCsv(
  report: MileageReport,
  fallbackRate: number,
): {
  entries: number;
  miles: number;
  cents: number;
  expense_count: number;
  expense_cents: number;
} {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const reportName = `Mileage ${report.from} to ${report.to}`;
  const rows: string[] = [
    [
      "Report Name",
      "Transaction Date",
      "Expense Type",
      "From Location",
      "To Location",
      "Distance",
      "Distance Unit",
      "Rate",
      "Amount",
      "Currency",
      "Business Purpose",
      "Comment",
    ]
      .map(esc)
      .join(","),
  ];
  let entries = 0;
  let miles = 0;
  let cents = 0;
  for (const d of report.days) {
    for (const l of d.legs) {
      if (l.entry_kind !== "business") continue;
      const rate = l.rate_per_mile ?? fallbackRate;
      const amount = Math.round(l.business_miles * rate * 100) / 100;
      const comment = [
        l.miles_no_toll !== null ? (l.used_tollway ? "Tollway route" : "Back roads route") : "",
        l.vehicle ?? "",
        l.notes ?? "",
      ]
        .filter(Boolean)
        .join("; ");
      rows.push(
        [
          reportName,
          d.date,
          "Personal Car Mileage",
          l.start_address || "",
          l.end_address || "",
          l.business_miles.toFixed(2),
          "Miles",
          rate.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0"),
          amount.toFixed(2),
          "USD",
          "Home health patient visits",
          comment,
        ]
          .map(esc)
          .join(","),
      );
      entries += 1;
      miles += l.business_miles;
      cents += Math.round(amount * 100);
    }
  }
  // Deploy-41: itemized expense lines ride the same file,
  // one row per line AFTER the mileage rows, in the same
  // column shape (no locations / distance / rate).
  let expense_count = 0;
  let expense_cents = 0;
  for (const e of report.expenses ?? []) {
    const comment = [e.vendor_name ?? "", e.notes ?? ""]
      .filter(Boolean)
      .join("; ");
    rows.push(
      [
        reportName,
        e.expense_date,
        expenseCategoryLabel(e.category),
        "",
        "",
        "",
        "Miles",
        "",
        (e.amount_cents / 100).toFixed(2),
        "USD",
        e.description || "Business expense",
        comment,
      ]
        .map(esc)
        .join(","),
    );
    expense_count += 1;
    expense_cents += e.amount_cents;
    cents += e.amount_cents;
  }
  const blob = new Blob(["\uFEFF" + rows.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `concur-mileage-${report.from}_to_${report.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return { entries, miles, cents, expense_count, expense_cents };
}
