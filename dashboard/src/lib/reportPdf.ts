// Client-side PDF export for the Reports view. Runs entirely in the
// browser — nothing is sent to any server. The PDF mirrors the Reports
// page: headline stats plus the weekly flags-reviewed table, stamped as
// demo data.
import { jsPDF } from "jspdf";
import { analytics } from "./demoData";

export function downloadReportPdf() {
  const doc = new jsPDF();
  const margin = 20;
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 20;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Marc Innotech - Clinic Report", margin, y);
  y += 8;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(
    `Generated ${new Date().toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    })} - Demo data only`,
    margin,
    y,
  );
  y += 4;
  doc.setDrawColor(13, 148, 136);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageWidth - margin, y);
  y += 10;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Headline stats (demo)", margin, y);
  y += 8;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  const stats = [
    `People under care: ${analytics.peopleUnderCare}`,
    `Green / Yellow / Red: ${analytics.green} / ${analytics.yellow} / ${analytics.red}`,
    `Open triage tickets: ${analytics.openTickets}`,
    `Flags reviewed this week: ${analytics.flagsReviewedThisWeek}`,
    `Admin hours returned (illustrative): ${analytics.adminHoursReturnedIllustrative} hrs`,
  ];
  for (const line of stats) {
    doc.text(line, margin, y);
    y += 7;
  }
  y += 4;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Flags reviewed per week (demo)", margin, y);
  y += 8;
  const weekX = margin + 2;
  const countX = pageWidth - margin - 38;
  const rowH = 8;
  doc.setFillColor(13, 148, 136);
  doc.rect(margin, y - 6, pageWidth - margin * 2, rowH, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(12);
  doc.text("Week", weekX, y);
  doc.text("Flags reviewed", countX, y);
  y += rowH;
  doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "normal");
  analytics.weeklyLabels.forEach((label, i) => {
    doc.text(label, weekX, y);
    doc.text(String(analytics.weeklyFlagsReviewed[i]), countX, y);
    doc.setDrawColor(220, 220, 220);
    doc.line(margin, y + 2, pageWidth - margin, y + 2);
    y += rowH;
  });
  y += 6;
  doc.setFontSize(11);
  doc.text(
    "Demo data only - synthetic and invented for demonstration. Not a performance claim.",
    margin,
    y,
  );

  const stamp = new Date().toISOString().slice(0, 10);
  doc.save(`marc-innotech-report-${stamp}.pdf`);
}
