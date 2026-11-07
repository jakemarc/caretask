// Mileage view (2026-11-02, Jake's simplification) — a
// per-day chain log plus generated expense reports. No
// approval process: log the day's driving as a chain of legs,
// generate a report for any month / date range, filtered by
// agency.
//
// The chain: Home -> Office bookends are fixed PERSONAL legs
// (home from the clinician's staff profile; office from the
// clinician's own office address in Settings -> Home & Office
// when set, else the agency profile; their miles snapshot onto
// the day's legs, so later address changes never rewrite
// history). Stops in
// between are billable legs in visit order, ending back at
// the office. Every leg's start and end can be set by tapping
// a known place (Home / Office / a patient) or typing an
// address with autocomplete. Routing defaults to the tollway
// figure; a per-leg toggle marks back roads instead, and
// miles stay hand-correctable after routing.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import {
  AlertTriangle,
  Building2,
  CalendarPlus,
  Check,
  Home,
  GripVertical,
  LocateFixed,
  MapPin,
  Pencil,
  Plus,
  Printer,
  Trash2,
  X,
} from "lucide-react";
import ReceiptsPanel from "./ReceiptsPanel";
import AddressAutocomplete, {
  type SuggestedAddress,
} from "./AddressAutocomplete";
import type { PersonUnderCare } from "../lib/demoData";
import {
  fetchAgencies,
  listAppointments,
  type ApiAgency,
  type ApiUser,
} from "../lib/patientApi";
import { geocodeFreeText, haversineMiles, reverseGeocode } from "../lib/geo";
import {
  createExpenseLine,
  createMileage,
  createReport,
  deleteExpenseLine,
  deleteMileage,
  expenseCategoryLabel,
  EXPENSE_CATEGORIES,
  fetchExpenseLines,
  fetchMileage,
  fetchMileageReport,
  fetchReport,
  fetchReports,
  resolveRate,
  routeMiles,
  transitionReport,
  updateExpenseLine,
  updateMileage,
  type ApiRequestError,
  type ChainReportDetail,
  type ExpenseLine,
  type MileageEntry,
  type MileageReport,
  type ReceiptViolation,
  type SavedReport,
} from "../lib/expensesApi";
import { isManagerRole, useMyStaff } from "../lib/useMyRole";
import { useMediaQuery } from "../lib/useMediaQuery";

// ---------- small helpers ----------

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

function prettyDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function joinAddress(
  street?: string | null,
  city?: string | null,
  state?: string | null,
  zip?: string | null,
): string {
  const cityState = [city, state].filter(Boolean).join(", ");
  return [street, cityState, zip].filter(Boolean).join(", ");
}

function suggestedToAddress(a: SuggestedAddress): string {
  return joinAddress(a.street, a.city, a.state, a.postal_code);
}

// Patient re-match on an address change (Jake, 2026-11-06):
// when a stop's address is edited, the new address is
// matched against the addresses on file for the clinician's
// patients (the `people` prop — the same records the patient
// picker and the calendar fill read). Normalization:
// lowercase, punctuation stripped, whitespace collapsed. A
// patient matches when their street and city both appear as
// whole tokens in the edited address and, when both sides
// carry a ZIP, the ZIPs agree. Only an EXACTLY-ONE match
// re-identifies the stop — a shared household address (two
// patients on file) leaves the stop exactly as set.
function normalizeAddrText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function matchPatientByAddress(
  address: string,
  patients: PersonUnderCare[],
): PersonUnderCare | null {
  const norm = normalizeAddrText(address);
  if (!norm) return null;
  const padded = ` ${norm} `;
  const stopZip = norm.match(/\b\d{5}\b/)?.[0] ?? null;
  const hits = patients.filter((p) => {
    const street = normalizeAddrText(p.street ?? "");
    if (!street || !padded.includes(` ${street} `)) return false;
    const city = normalizeAddrText(p.city ?? "");
    if (city && !padded.includes(` ${city} `)) return false;
    const pz = (p.postalCode ?? "").replace(/\D/g, "").slice(0, 5);
    if (pz && stopZip && pz !== stopZip) return false;
    return true;
  });
  return hits.length === 1 ? hits[0] : null;
}

function errText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- chain model ----------

type StopKind = "home" | "office" | "patient" | "custom";

interface Stop {
  key: string;
  kind: StopKind;
  label: string;
  address: string;
  lat: number | null;
  lng: number | null;
  patient_id: string | null;
}

interface LegState {
  miles_toll: number | null;
  miles_no_toll: number | null;
  used_tollway: boolean;
  miles: string;
  kind_override: "business" | "commute" | null;
  appointment_id: string | null;
  saved_id: number | null;
  // Deploy-41: receipt count from the saved entry (the
  // ReceiptsPanel badge seeds from it).
  receipt_count: number;
  routed_sig: string;
  routing: boolean;
  route_failed: boolean;
}

const blankLeg = (): LegState => ({
  miles_toll: null,
  miles_no_toll: null,
  used_tollway: true,
  miles: "",
  kind_override: null,
  appointment_id: null,
  saved_id: null,
  receipt_count: 0,
  routed_sig: "",
  routing: false,
  route_failed: false,
});

let stopSeq = 0;
const nextKey = () => `stop-${(stopSeq += 1)}`;

// The blank stop every "add" path starts from — the
// chain-end Add a stop and the per-row insert alike.
const blankStop = (): Stop => ({
  key: nextKey(),
  kind: "custom",
  label: "",
  address: "",
  lat: null,
  lng: null,
  patient_id: null,
});

function legKind(
  from: Stop,
  to: Stop,
  override: "business" | "commute" | null,
): "business" | "commute" {
  if (override) return override;
  const bookend =
    (from.kind === "home" && to.kind === "office") ||
    (from.kind === "office" && to.kind === "home");
  return bookend ? "commute" : "business";
}

// The routed figure for the leg's selected route (tollway
// choice) — the same fallback expression routing and the
// tollway toggle use. Null until the leg has routed.
function routedFor(leg: LegState): number | null {
  return leg.used_tollway
    ? (leg.miles_toll ?? leg.miles_no_toll)
    : (leg.miles_no_toll ?? leg.miles_toll);
}

// The leg's effective miles. LegState.miles is its own
// field, distinct from the routed figures: routing seeds
// it, a hand edit overrides it, and every total, the save
// payload, and (through the saved entries) the report and
// Concur CSV read it. "" means "no miles yet".
function effMiles(leg: LegState): number | null {
  if (leg.miles.trim() === "") return null;
  const n = Number(leg.miles);
  return Number.isNaN(n) ? null : n;
}

const fmtMi = (n: number) => String(round2(n));

function stopFromEndpoint(
  label: string | null,
  address: string | null,
  lat: number | null,
  lng: number | null,
  patientId: string | null,
  officeLabel: string,
): Stop {
  const kind: StopKind = patientId
    ? "patient"
    : label === "Home"
      ? "home"
      : label === "Office" || label === officeLabel
        ? "office"
        : "custom";
  return {
    key: nextKey(),
    kind,
    label: label ?? "",
    address: address ?? "",
    lat,
    lng,
    patient_id: patientId,
  };
}

// ---------- component ----------

export default function ExpensesView({
  user,
  people,
  apiConnected,
  autoOpenCurrent = false,
  focusReportNonce = 0,
}: {
  user: User;
  people: PersonUnderCare[];
  apiConnected: boolean;
  // Opened from the mobile Mileage pill: the day log defaults
  // to today, which is exactly what this view opens on.
  autoOpenCurrent?: boolean;
  // Reports submenu → Mileage Report (Jake, 2026-11-06):
  // Dashboard bumps this counter on each submenu click; when
  // it changes (and is > 0) the Expense report card scrolls
  // into view. Plain Expenses navigation leaves it at 0.
  focusReportNonce?: number;
}) {
  void autoOpenCurrent;
  const me = useMyStaff(user);
  // Desktop table rendering of the chain (Jake, 2026-11-06):
  // at the stylesheet's established wide breakpoint
  // (min-width: 1001px — where layouts go multi-column) the
  // stops render as a table, one row per stop with the
  // incoming leg in its own column; below it the list
  // rendering is unchanged. Only one of the two is mounted,
  // and both share the same stops/legs state and handlers.
  const wideChain = useMediaQuery("(min-width: 1001px)");

  const [agencies, setAgencies] = useState<ApiAgency[] | null>(null);
  const [agencyId, setAgencyId] = useState<number | null>(null);
  const [date, setDate] = useState(todayStr());
  const [stops, setStops] = useState<Stop[]>([]);
  const [legs, setLegs] = useState<LegState[]>([]);
  const [loadedIds, setLoadedIds] = useState<number[]>([]);
  const [dayLoaded, setDayLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [rate, setRate] = useState<string>(
    () => localStorage.getItem("caretask-mileage-rate") ?? "0.70",
  );
  // Deploy-41: the rate table resolves the rate for the
  // selected date. "table" = the input came from
  // GET /mileage-rates/resolve; "stored" = no rate in effect
  // for the date, so the localStorage fallback stands. A hand
  // edit wins for that day: the resolving effect only runs
  // when the DATE changes, and the manual-edit marker stops
  // a late resolve for the same date overwriting the edit.
  const [rateSource, setRateSource] = useState<"table" | "stored">("stored");
  const rateEditedDateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!apiConnected) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await resolveRate(user, date);
        if (cancelled || rateEditedDateRef.current === date) return;
        if (res.rate !== null) {
          setRate(String(res.rate));
          setRateSource("table");
        } else {
          setRate(localStorage.getItem("caretask-mileage-rate") ?? "0.70");
          setRateSource("stored");
        }
      } catch {
        // Resolution is a nicety — the stored fallback stands.
        if (!cancelled) setRateSource("stored");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [date, user, apiConnected]);
  // Bookends (Home/Office stops) hidden by default (Jake,
  // 2026-11-06) — they're fixed by the addresses, so the chain
  // reads as just the day's visits. The toggle in the chain
  // header brings them back; the choice persists per browser.
  // Hiding is render-only: legs, classification, and totals
  // are computed from the full chain either way.
  const [showBookends, setShowBookends] = useState<boolean>(
    () => localStorage.getItem("caretask-mileage-bookends") === "show",
  );
  const toggleBookends = (show: boolean) => {
    setShowBookends(show);
    localStorage.setItem("caretask-mileage-bookends", show ? "show" : "hide");
    if (!show) {
      setEditingKey((k) =>
        k && stops.some((s) => s.key === k && (s.kind === "home" || s.kind === "office"))
          ? null
          : k,
      );
    }
  };

  const [repMode, setRepMode] = useState<"month" | "range">("month");
  const [repMonth, setRepMonth] = useState(() => todayStr().slice(0, 7));
  const [repFrom, setRepFrom] = useState(() => monthRange(todayStr().slice(0, 7)).from);
  const [repTo, setRepTo] = useState(() => monthRange(todayStr().slice(0, 7)).to);
  const [repAgency, setRepAgency] = useState<number | null>(null);
  const [report, setReport] = useState<MileageReport | null>(null);
  const [repBusy, setRepBusy] = useState(false);
  const [repNotice, setRepNotice] = useState("");
  const [repError, setRepError] = useState("");

  // ---------- deploy-41: itemized lines for the chain date ----------
  const [dayExpenses, setDayExpenses] = useState<ExpenseLine[] | null>(null);
  const [expError, setExpError] = useState("");
  const [expBusy, setExpBusy] = useState(false);
  const [expEditingId, setExpEditingId] = useState<number | null>(null);
  const [expDate, setExpDate] = useState(todayStr());
  const [expCategory, setExpCategory] = useState<string>("tolls");
  const [expAmount, setExpAmount] = useState("");
  const [expVendor, setExpVendor] = useState("");
  const [expDesc, setExpDesc] = useState("");
  const [expNotes, setExpNotes] = useState("");

  const loadDayExpenses = useCallback(
    async (forDate: string, forAgency: number | null) => {
      try {
        const rows = await fetchExpenseLines(user, {
          from: forDate,
          to: forDate,
          agency_id: forAgency,
        });
        setDayExpenses(rows);
      } catch (err) {
        setExpError(errText(err, "Could not load this day's other expenses."));
        setDayExpenses([]);
      }
    },
    [user],
  );

  useEffect(() => {
    if (!apiConnected) return;
    setExpEditingId(null);
    setExpDate(date);
    setExpAmount("");
    setExpVendor("");
    setExpDesc("");
    setExpNotes("");
    setExpCategory("tolls");
    void loadDayExpenses(date, agencyId);
  }, [apiConnected, date, agencyId, loadDayExpenses]);

  const resetExpForm = () => {
    setExpEditingId(null);
    setExpDate(date);
    setExpCategory("tolls");
    setExpAmount("");
    setExpVendor("");
    setExpDesc("");
    setExpNotes("");
  };

  const saveExpenseLine = async () => {
    const dollars = Number(expAmount);
    if (!expAmount || Number.isNaN(dollars) || dollars <= 0) {
      setExpError("Enter an amount above zero.");
      return;
    }
    if (!expDate) {
      setExpError("Pick a date for the expense.");
      return;
    }
    setExpBusy(true);
    setExpError("");
    try {
      const input = {
        expense_date: expDate,
        category: expCategory,
        description: expDesc.trim() || null,
        vendor_name: expVendor.trim() || null,
        amount_cents: Math.round(dollars * 100),
        agency_id: agencyId,
        notes: expNotes.trim() || null,
      };
      if (expEditingId !== null) {
        await updateExpenseLine(user, expEditingId, input);
      } else {
        await createExpenseLine(user, input);
      }
      resetExpForm();
      await loadDayExpenses(date, agencyId);
    } catch (err) {
      setExpError(errText(err, "Could not save that expense."));
    } finally {
      setExpBusy(false);
    }
  };

  const editExpenseLine = (line: ExpenseLine) => {
    setExpEditingId(line.id);
    setExpDate(line.expense_date);
    setExpCategory(line.category);
    setExpAmount((line.amount_cents / 100).toFixed(2));
    setExpVendor(line.vendor_name ?? "");
    setExpDesc(line.description ?? "");
    setExpNotes(line.notes ?? "");
    setExpError("");
  };

  const removeExpenseLine = async (line: ExpenseLine) => {
    setExpBusy(true);
    setExpError("");
    try {
      await deleteExpenseLine(user, line.id);
      if (expEditingId === line.id) resetExpForm();
      await loadDayExpenses(date, agencyId);
    } catch (err) {
      setExpError(errText(err, "Could not delete that expense."));
    } finally {
      setExpBusy(false);
    }
  };

  // ---------- deploy-41: saved reports + lifecycle ----------
  const [savedReports, setSavedReports] = useState<SavedReport[] | null>(null);
  const [detail, setDetail] = useState<ChainReportDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailNotice, setDetailNotice] = useState("");
  const [detailViolations, setDetailViolations] = useState<ReceiptViolation[]>([]);
  const [rejectNote, setRejectNote] = useState("");
  const [paymentRef, setPaymentRef] = useState("");

  const loadSavedReports = useCallback(async () => {
    try {
      setSavedReports(await fetchReports(user));
    } catch {
      setSavedReports([]);
    }
  }, [user]);

  useEffect(() => {
    if (!apiConnected) return;
    void loadSavedReports();
  }, [apiConnected, loadSavedReports]);

  const openSavedReport = async (id: number) => {
    setDetailBusy(true);
    setDetailError("");
    setDetailNotice("");
    setDetailViolations([]);
    setRejectNote("");
    setPaymentRef("");
    try {
      setDetail(await fetchReport(user, id));
    } catch (err) {
      setDetailError(errText(err, "Could not open that report."));
    } finally {
      setDetailBusy(false);
    }
  };

  const saveAsReport = async () => {
    if (!report) return;
    setRepBusy(true);
    setRepError("");
    setRepNotice("");
    try {
      const saved = await createReport(user, {
        period_start: report.from,
        period_end: report.to,
        agency_id: report.agency_id,
      });
      setRepNotice("Report saved — find it under Saved reports below.");
      await loadSavedReports();
      await openSavedReport(saved.id);
    } catch (err) {
      const e = err as ApiRequestError | null;
      const existingId = (e?.body as { existing_id?: number } | null | undefined)
        ?.existing_id;
      if (e?.code === "REPORT_EXISTS" && existingId) {
        setRepNotice("A report for this period already exists — opened it below.");
        await loadSavedReports();
        await openSavedReport(existingId);
      } else {
        setRepError(errText(err, "Could not save this report."));
      }
    } finally {
      setRepBusy(false);
    }
  };

  const doTransition = async (
    to: "submitted" | "approved" | "rejected" | "draft" | "paid",
  ) => {
    if (!detail) return;
    setDetailBusy(true);
    setDetailError("");
    setDetailNotice("");
    setDetailViolations([]);
    try {
      await transitionReport(user, detail.report.id, {
        to,
        note: to === "rejected" && rejectNote.trim() ? rejectNote.trim() : undefined,
        payment_ref:
          to === "paid" && paymentRef.trim() ? paymentRef.trim() : undefined,
      });
      setDetailNotice(
        to === "submitted"
          ? "Report submitted."
          : to === "approved"
            ? "Report approved."
            : to === "rejected"
              ? "Report rejected."
              : to === "paid"
                ? "Report marked paid."
                : "Report returned to draft.",
      );
      setDetail(await fetchReport(user, detail.report.id));
      await loadSavedReports();
    } catch (err) {
      const e = err as ApiRequestError | null;
      if (e?.code === "RECEIPTS_REQUIRED") {
        const violations = (
          e.body as { violations?: ReceiptViolation[] } | null | undefined
        )?.violations;
        setDetailViolations(violations ?? []);
      }
      setDetailError(errText(err, "That transition didn't go through."));
    } finally {
      setDetailBusy(false);
    }
  };
  // Reports submenu → Mileage Report landing: scroll the
  // Expense report card into view when Dashboard bumps the
  // nonce. The short delay lets the freshly mounted view lay
  // out first; a no-op when the card isn't rendered (e.g. the
  // API isn't connected and the early-return section shows).
  const reportCardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusReportNonce) return;
    const t = window.setTimeout(() => {
      reportCardRef.current?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    }, 60);
    return () => window.clearTimeout(t);
  }, [focusReportNonce]);

  const officeCache = useRef(new Map<number, Stop>());
  const myOfficeCache = useRef<Stop | null>(null);
  const homeCache = useRef<Stop | null>(null);

  const agency = agencies?.find((a) => a.id === agencyId) ?? null;

  // ---------- endpoint resolution ----------

  const homeStop = useCallback(async (): Promise<Stop | null> => {
    if (homeCache.current) return homeCache.current;
    if (!me) return null;
    const address = joinAddress(me.street, me.city, me.state, me.zip);
    if (!address) return null;
    const geo = await geocodeFreeText(address);
    const stop: Stop = {
      key: nextKey(),
      kind: "home",
      label: "Home",
      address,
      lat: geo?.lat ?? null,
      lng: geo?.lon ?? null,
      patient_id: null,
    };
    homeCache.current = stop;
    return stop;
  }, [me]);

  // The clinician's own office address (Settings -> Home &
  // Office) wins over the agency's address when any part of it
  // is set; days saved with it carry the label "Office".
  const hasPersonalOffice = !!(
    me?.office_street || me?.office_city || me?.office_state || me?.office_zip
  );

  const myOfficeStop = useCallback(async (): Promise<Stop | null> => {
    if (myOfficeCache.current) return myOfficeCache.current;
    if (!me) return null;
    const address = joinAddress(
      me.office_street,
      me.office_city,
      me.office_state,
      me.office_zip,
    );
    if (!address) return null;
    const geo = await geocodeFreeText(address);
    const stop: Stop = {
      key: nextKey(),
      kind: "office",
      label: "Office",
      address,
      lat: geo?.lat ?? null,
      lng: geo?.lon ?? null,
      patient_id: null,
    };
    myOfficeCache.current = stop;
    return stop;
  }, [me]);

  const officeStop = useCallback(
    async (a: ApiAgency | null): Promise<Stop | null> => {
      const personal = await myOfficeStop();
      if (personal) return personal;
      if (!a) return null;
      const cached = officeCache.current.get(a.id);
      if (cached) return cached;
      const address = joinAddress(a.street, a.city, a.state, a.postal_code);
      if (!address) return null;
      const geo = await geocodeFreeText(address);
      const stop: Stop = {
        key: nextKey(),
        kind: "office",
        label: a.display_name,
        address,
        lat: geo?.lat ?? null,
        lng: geo?.lon ?? null,
        patient_id: null,
      };
      officeCache.current.set(a.id, stop);
      return stop;
    },
    [myOfficeStop],
  );

  // ---------- day loading ----------

  const loadDay = useCallback(
    async (forDate: string, forAgency: number | null, agencyList: ApiAgency[]) => {
      setError("");
      setNotice("");
      setEditingKey(null);
      const entries = await fetchMileage(user, {
        from: forDate,
        to: forDate,
        agency_id: forAgency,
      });
      const ag = agencyList.find((a) => a.id === forAgency) ?? null;
      // Days saved with the clinician's own office carry the
      // label "Office"; agency-office days carry the agency's
      // display name. Classify against the source in play.
      const oLabel = hasPersonalOffice
        ? "Office"
        : (ag?.display_name ?? "Office");
      if (entries.length) {
        const rebuilt: Stop[] = [
          stopFromEndpoint(
            entries[0].start_label,
            entries[0].start_address,
            entries[0].start_lat,
            entries[0].start_lng,
            null,
            oLabel,
          ),
        ];
        const rebuiltLegs: LegState[] = [];
        for (const e of entries) {
          rebuilt.push(
            stopFromEndpoint(
              e.end_label,
              e.end_address,
              e.end_lat,
              e.end_lng,
              e.patient_id,
              oLabel,
            ),
          );
          rebuiltLegs.push({
            miles_toll: e.miles_toll,
            miles_no_toll: e.miles_no_toll,
            used_tollway: e.used_tollway,
            miles: e.business_miles ? String(e.business_miles) : "",
            kind_override:
              (e.entry_kind === "commute" &&
                !(
                  (rebuilt[rebuilt.length - 2].kind === "home" &&
                    rebuilt[rebuilt.length - 1].kind === "office") ||
                  (rebuilt[rebuilt.length - 2].kind === "office" &&
                    rebuilt[rebuilt.length - 1].kind === "home")
                )) ||
              (e.entry_kind === "business" &&
                ((rebuilt[rebuilt.length - 2].kind === "home" &&
                  rebuilt[rebuilt.length - 1].kind === "office") ||
                  (rebuilt[rebuilt.length - 2].kind === "office" &&
                    rebuilt[rebuilt.length - 1].kind === "home")))
                ? e.entry_kind
                : null,
            appointment_id: e.appointment_id ? String(e.appointment_id) : null,
            saved_id: e.id,
            receipt_count: e.receipt_count ?? 0,
            routed_sig:
              e.start_lat !== null && e.end_lat !== null
                ? `${e.start_lat},${e.start_lng}->${e.end_lat},${e.end_lng}`
                : "",
            routing: false,
            route_failed: false,
          });
        }
        setStops(rebuilt);
        setLegs(rebuiltLegs);
        setLoadedIds(entries.map((e) => e.id));
      } else {
        // Fresh day: prefill the fixed bookends when both
        // addresses are known.
        const home = await homeStop();
        const office = await officeStop(ag);
        if (home && office) {
          setStops([
            { ...home, key: nextKey() },
            { ...office, key: nextKey() },
            { ...home, key: nextKey() },
          ]);
          setLegs([blankLeg(), blankLeg()]);
          setNotice("");
        } else {
          setStops([]);
          setLegs([]);
          if (!home) {
            setNotice(
              "Add your home address in Settings → Home & Office and the Home bookends will fill themselves in — you can still add stops by hand below.",
            );
          }
        }
        setLoadedIds([]);
      }
      setDirty(false);
      setDayLoaded(true);
    },
    [user, homeStop, officeStop, hasPersonalOffice],
  );

  // Initial data: agencies + patients, then the day.
  useEffect(() => {
    if (!apiConnected) return;
    let cancelled = false;
    (async () => {
      try {
        const ags = await fetchAgencies(user);
        if (cancelled) return;
        const active = ags.filter((a) => a.active);
        setAgencies(active);
        const primary = active.find((a) => a.is_primary) ?? active[0] ?? null;
        const initialAgency = primary ? primary.id : null;
        setAgencyId(initialAgency);
        setRepAgency(initialAgency);
        await loadDay(todayStr(), initialAgency, active);
      } catch (err) {
        if (!cancelled) setError(errText(err, "Could not load mileage data."));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiConnected, user]);

  const switchDay = async (nextDate: string, nextAgency: number | null) => {
    if (dirty) {
      setError("Save this day first — switching would drop unsaved changes.");
      return;
    }
    // A new date re-resolves its rate from the table, even
    // if a previous visit to that date ended in a hand edit.
    if (nextDate !== date) rateEditedDateRef.current = null;
    setDate(nextDate);
    setAgencyId(nextAgency);
    setDayLoaded(false);
    try {
      await loadDay(nextDate, nextAgency, agencies ?? []);
    } catch (err) {
      setError(errText(err, "Could not load that day."));
      setDayLoaded(true);
    }
  };

  // ---------- drag to reorder ----------
  // Middle stops (patient / custom) drag by their grip handle
  // (Jake, 2026-11-06); Home/Office bookends stay pinned.
  // Pointer-based so it works with touch on the phone. On a
  // swap, legs are rebuilt by endpoint pair: a leg whose
  // from→to pair still exists keeps its data; a new pair gets
  // a fresh leg (it re-routes itself) that inherits the
  // appointment link + tollway choice of the leg that used to
  // END at the same stop.
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const legsRef = useRef(legs);
  legsRef.current = legs;
  // Row elements by stop key, measured for drag swap
  // thresholds: <div> wrappers in the list rendering,
  // <tr> elements in the desktop table — whichever is
  // mounted registers here.
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<{ key: string; startY: number } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragDy, setDragDy] = useState(0);

  const isDraggableStop = (s: Stop) => s.kind === "patient" || s.kind === "custom";

  const doReorder = (fromIdx: number, toIdx: number) => {
    const cur = stopsRef.current;
    const curLegs = legsRef.current;
    if (fromIdx === toIdx || !cur[fromIdx] || !cur[toIdx]) return;
    const next = [...cur];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    const pairLeg = new Map<string, LegState>();
    curLegs.forEach((l, i) => {
      if (cur[i] && cur[i + 1]) pairLeg.set(`${cur[i].key}->${cur[i + 1].key}`, l);
    });
    const followLeg = new Map<string, LegState>();
    curLegs.forEach((l, i) => {
      if (cur[i + 1]) followLeg.set(cur[i + 1].key, l);
    });
    const newLegs = next.slice(1).map((to, i) => {
      const from = next[i];
      const old = pairLeg.get(`${from.key}->${to.key}`);
      if (old) return old;
      const follow = followLeg.get(to.key);
      return {
        ...blankLeg(),
        appointment_id: follow?.appointment_id ?? null,
        used_tollway: follow?.used_tollway ?? true,
      };
    });
    setStops(next);
    setLegs(newLegs);
    setDirty(true);
  };

  const onDragHandleDown = (e: React.PointerEvent, stop: Stop) => {
    if (editingKey) return;
    e.preventDefault();
    dragRef.current = { key: stop.key, startY: e.clientY };
    setDragKey(stop.key);
    setDragDy(0);
  };

  useEffect(() => {
    if (!dragKey) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const cur = stopsRef.current;
      const idx = cur.findIndex((s) => s.key === d.key);
      if (idx < 0) return;
      let dy = e.clientY - d.startY;
      if (dy > 0 && idx < cur.length - 1 && isDraggableStop(cur[idx + 1])) {
        const h = rowRefs.current.get(cur[idx + 1].key)?.offsetHeight ?? 0;
        if (h > 0 && dy > h / 2) {
          doReorder(idx, idx + 1);
          d.startY += h;
          dy -= h;
        }
      } else if (dy < 0 && idx > 0 && isDraggableStop(cur[idx - 1])) {
        const h = rowRefs.current.get(cur[idx - 1].key)?.offsetHeight ?? 0;
        if (h > 0 && dy < -h / 2) {
          doReorder(idx, idx - 1);
          d.startY -= h;
          dy += h;
        }
      }
      setDragDy(dy);
    };
    const onUp = () => {
      dragRef.current = null;
      setDragKey(null);
      setDragDy(0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragKey, editingKey]);

  // ---------- routing ----------
  // Route any leg whose endpoints both have coordinates and
  // whose coordinate signature has not been routed yet.
  useEffect(() => {
    if (!dayLoaded) return;
    legs.forEach((leg, i) => {
      const from = stops[i];
      const to = stops[i + 1];
      if (!from || !to) return;
      if (from.lat === null || from.lng === null || to.lat === null || to.lng === null) return;
      const sig = `${from.lat},${from.lng}->${to.lat},${to.lng}`;
      if (leg.routed_sig === sig || leg.routing) return;
      setLegs((prev) =>
        prev.map((l, j) => (j === i ? { ...l, routing: true, route_failed: false } : l)),
      );
      routeMiles(user, { lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng })
        .then(({ miles_toll, miles_no_toll }) => {
          setLegs((prev) =>
            prev.map((l, j) => {
              if (j !== i) return l;
              const used = l.used_tollway
                ? (miles_toll ?? miles_no_toll)
                : (miles_no_toll ?? miles_toll);
              return {
                ...l,
                miles_toll,
                miles_no_toll,
                miles: used !== null ? String(used) : l.miles,
                routed_sig: sig,
                routing: false,
              };
            }),
          );
          setDirty(true);
        })
        .catch(() => {
          setLegs((prev) =>
            prev.map((l, j) =>
              j === i ? { ...l, routed_sig: sig, routing: false, route_failed: true } : l,
            ),
          );
        });
    });
  }, [stops, legs, dayLoaded, user]);

  // ---------- chain editing ----------

  const updateStop = (key: string, stop: Stop) => {
    const idx = stops.findIndex((s) => s.key === key);
    const prev = idx >= 0 ? stops[idx] : null;
    let next = stop;
    // Address changed on a patient/custom stop → re-match
    // the patient (Jake, 2026-11-06): exactly one patient
    // with that address on file and the stop becomes that
    // patient — link, name, and coordinates from the
    // record. No match or an ambiguous one leaves the stop
    // as the user set it; a patient pick in the editor
    // already carries the picked patient's own address, so
    // the match agrees with the pick and never fights it.
    // Bookends keep their Home/Office identity regardless.
    if (
      prev &&
      stop.address &&
      stop.address !== prev.address &&
      stop.kind !== "home" &&
      stop.kind !== "office"
    ) {
      const p = matchPatientByAddress(stop.address, people);
      if (p) {
        next = {
          ...stop,
          kind: "patient",
          label: p.lname && p.fname ? `${p.lname}, ${p.fname}` : p.name,
          lat: p.latitude ?? null,
          lng: p.longitude ?? null,
          patient_id: p.id,
        };
      }
    }
    setStops((prevStops) =>
      prevStops.map((s) => (s.key === key ? { ...next, key } : s)),
    );
    // Endpoint moved (address and/or coordinates changed —
    // including via the re-match above, which can move the
    // coordinates) → BOTH adjacent legs recalculate and any
    // hand-entered miles on them are discarded (Jake,
    // 2026-11-06): the override belonged to the old
    // endpoints. Clearing routed_sig + the routed figures +
    // miles makes the routing effect re-route and reseed
    // miles from the new route; with no coordinates on the
    // new endpoint the miles stay blank instead of keeping
    // a stale number. Unchanged endpoints keep their legs —
    // and their overrides — untouched, which is also what
    // keeps a kept pair in doReorder honest: pairs are
    // keyed by stop key, but an address edit lands here
    // first and invalidates the legs before any reorder.
    if (
      prev &&
      (next.address !== prev.address ||
        next.lat !== prev.lat ||
        next.lng !== prev.lng)
    ) {
      setLegs((prevLegs) =>
        prevLegs.map((l, j) =>
          j === idx - 1 || j === idx
            ? {
                ...l,
                miles: "",
                miles_toll: null,
                miles_no_toll: null,
                routed_sig: "",
                routing: false,
                route_failed: false,
              }
            : l,
        ),
      );
    }
    setDirty(true);
    setEditingKey(null);
  };

  const addStop = () => {
    const blank = blankStop();
    // Keep the bookend template [home, office, ...stops...,
    // office, home]: a bare [home, office, home] day splits
    // its single office into start + return stops for the
    // first middle stop; later stops insert before the
    // closing office. Non-template chains just append.
    let next: Stop[];
    const lastStop = stops[stops.length - 1];
    const secondLast = stops[stops.length - 2];
    if (
      stops.length === 3 &&
      stops[0].kind === "home" &&
      secondLast?.kind === "office" &&
      lastStop?.kind === "home"
    ) {
      const officeCopy: Stop = { ...secondLast, key: nextKey() };
      next = [stops[0], secondLast, blank, officeCopy, lastStop];
    } else if (
      stops.length > 3 &&
      secondLast?.kind === "office" &&
      lastStop?.kind === "home"
    ) {
      next = [...stops.slice(0, stops.length - 2), blank, secondLast, lastStop];
    } else {
      next = [...stops, blank];
    }
    setLegs((prev) => {
      const target = Math.max(0, next.length - 1);
      if (prev.length >= target) return prev;
      return [...prev, ...Array.from({ length: target - prev.length }, blankLeg)];
    });
    setStops(next);
    setDirty(true);
    setEditingKey(blank.key);
  };

  // Per-row insert (Jake, 2026-11-06): the + at the end
  // of a list row drops a new blank stop directly below
  // that row and opens its editor — switching editors
  // if another stop was being edited.
  const insertStopAfter = (idx: number) => {
    const blank = blankStop();
    // Bare template [home, office, home]: the single
    // office is both bookends, so inserting the first
    // visit below it splits it into start + return
    // copies — the same template fix addStop makes —
    // and the legs are rebuilt around the split: the
    // kept home→office leg keeps its miles, the other
    // three pairs are new and start blank.
    if (
      idx === 1 &&
      stops.length === 3 &&
      stops[0].kind === "home" &&
      stops[1].kind === "office" &&
      stops[2].kind === "home"
    ) {
      const officeCopy: Stop = { ...stops[1], key: nextKey() };
      setStops([stops[0], stops[1], blank, officeCopy, stops[2]]);
      setLegs((prev) => [
        prev[0] ?? blankLeg(),
        blankLeg(),
        blankLeg(),
        blankLeg(),
      ]);
    } else {
      setStops([
        ...stops.slice(0, idx + 1),
        blank,
        ...stops.slice(idx + 1),
      ]);
      // Splice the legs: the leg that connected the
      // tapped stop to the next one is replaced by two
      // blank legs — (tapped → new) and (new → next).
      // Both are new endpoint pairs, so they route fresh
      // once the new stop has coordinates; the replaced
      // leg's miles and any hand-entered override do
      // not carry into either. Every other leg keeps its
      // endpoints and its miles. Inserting below the
      // last stop appends its single new leg instead.
      setLegs((prev) => {
        const next = [...prev];
        if (idx < next.length) {
          next.splice(idx, 1, blankLeg(), blankLeg());
        } else {
          next.push(blankLeg());
        }
        return next;
      });
    }
    setDirty(true);
    setEditingKey(blank.key);
  };

  const removeStop = (key: string) => {
    const idx = stops.findIndex((s) => s.key === key);
    if (idx < 0) return;
    setStops((prev) => prev.filter((s) => s.key !== key));
    setLegs((prev) => {
      // Removing a stop merges its two adjacent legs into the
      // previous one; the merged leg re-routes from its new
      // endpoints. Removing an end stop drops its only leg.
      if (idx === 0) return prev.slice(1);
      if (idx === stops.length - 1) return prev.slice(0, -1);
      const next = [...prev];
      next.splice(idx, 1);
      next[idx - 1] = { ...next[idx - 1], routed_sig: "", miles_toll: null, miles_no_toll: null };
      return next;
    });
    setDirty(true);
  };

  const updateLeg = (i: number, patch: Partial<LegState>) => {
    setLegs((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  const toggleTollway = (i: number, tollway: boolean) => {
    const leg = legs[i];
    const used = tollway
      ? (leg.miles_toll ?? leg.miles_no_toll)
      : (leg.miles_no_toll ?? leg.miles_toll);
    updateLeg(i, {
      used_tollway: tollway,
      miles: used !== null ? String(used) : leg.miles,
    });
  };

  // ---------- save ----------

  const saveDay = async () => {
    setBusy(true);
    setError("");
    try {
      const rateNum = Number(rate);
      const savedIds: number[] = [];
      for (let i = 0; i < legs.length; i += 1) {
        const leg = legs[i];
        const from = stops[i];
        const to = stops[i + 1];
        const kind = legKind(from, to, leg.kind_override);
        const input = {
          entry_date: date,
          seq: i,
          entry_kind: kind,
          start_label: from.label || null,
          start_address: from.address || null,
          end_label: to.label || null,
          end_address: to.address || null,
          start_lat: from.lat,
          start_lng: from.lng,
          end_lat: to.lat,
          end_lng: to.lng,
          patient_id: to.patient_id,
          appointment_id: leg.appointment_id ? Number(leg.appointment_id) : null,
          agency_id: agencyId,
          miles_toll: leg.miles_toll,
          miles_no_toll: leg.miles_no_toll,
          used_tollway: leg.used_tollway,
          business_miles: Number(leg.miles) || 0,
          rate_per_mile: kind === "business" && rateNum > 0 ? rateNum : null,
        };
        const saved: MileageEntry = leg.saved_id
          ? await updateMileage(user, leg.saved_id, input)
          : await createMileage(user, input);
        savedIds.push(saved.id);
      }
      for (const id of loadedIds) {
        if (!savedIds.includes(id)) await deleteMileage(user, id);
      }
      localStorage.setItem("caretask-mileage-rate", rate);
      await loadDay(date, agencyId, agencies ?? []);
      setNotice("Day saved.");
    } catch (err) {
      setError(errText(err, "Could not save the day log."));
    } finally {
      setBusy(false);
    }
  };

  // ---------- fill from calendar ----------
  // Auto-populate the day's stops from this day's scheduled
  // visits (Jake, 2026-11-06): the personal calendar is the
  // source of the pattern — appointments for the signed-in
  // clinician, in start-time order. Chain: Home → Office →
  // each patient → Office → Home (bookends only where an
  // address resolves, mirroring the fresh-day prefill). A
  // visit whose patient has no address and no coordinates is
  // skipped and counted in the notice. Each leg keeps its
  // appointment id so the saved mileage ties to the visit.
  // Only offered while the day has no saved entries; it
  // replaces the unsaved chain and legs route themselves.
  const [filling, setFilling] = useState(false);

  const fillFromCalendar = async () => {
    setFilling(true);
    setError("");
    setNotice("");
    try {
      const start = new Date(`${date}T00:00:00`);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      const appts = await listAppointments(
        user,
        start.toISOString(),
        end.toISOString(),
      );
      const visits = appts
        .filter(
          (a) =>
            a.patient_id &&
            a.cattype === "appointment" &&
            !/cancel/i.test(a.status),
        )
        .sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
      if (!visits.length) {
        setNotice("No patient visits on your calendar for this day — add stops by hand below.");
        return;
      }
      const byId = new Map(people.map((p) => [String(p.id), p]));
      const patientStops: Stop[] = [];
      const apptByKey = new Map<string, string>();
      let skipped = 0;
      for (const a of visits) {
        const p = byId.get(String(a.patient_id));
        if (!p) {
          skipped += 1;
          continue;
        }
        const address = joinAddress(p.street, p.city, p.state, p.postalCode);
        if (!address && p.latitude == null) {
          skipped += 1;
          continue;
        }
        const stop: Stop = {
          key: nextKey(),
          kind: "patient",
          label: p.lname && p.fname ? `${p.lname}, ${p.fname}` : p.name,
          address,
          lat: p.latitude ?? null,
          lng: p.longitude ?? null,
          patient_id: p.id,
        };
        patientStops.push(stop);
        apptByKey.set(stop.key, a.id);
      }
      if (!patientStops.length) {
        setNotice(
          "Your calendar visits for this day have no patient addresses on file — add stops by hand below.",
        );
        return;
      }
      const home = await homeStop();
      const office = agency ? await officeStop(agency) : null;
      const chain: Stop[] = [];
      if (home) chain.push({ ...home, key: nextKey() });
      if (office) chain.push({ ...office, key: nextKey() });
      chain.push(...patientStops);
      if (office) chain.push({ ...office, key: nextKey() });
      if (home) chain.push({ ...home, key: nextKey() });
      const newLegs = chain.slice(1).map((to) => ({
        ...blankLeg(),
        appointment_id: apptByKey.get(to.key) ?? null,
      }));
      setStops(chain);
      setLegs(newLegs);
      setDirty(true);
      setNotice(
        `Filled from your calendar: ${patientStops.length} visit${patientStops.length === 1 ? "" : "s"} in time order` +
          (skipped ? ` · ${skipped} skipped (no address on file)` : "") +
          ". Legs route themselves — check the miles, then Save.",
      );
    } catch (err) {
      setError(errText(err, "Could not read your calendar for this day."));
    } finally {
      setFilling(false);
    }
  };

  // ---------- report ----------

  const generateReport = async () => {
    setRepBusy(true);
    setError("");
    try {
      const range = repMode === "month" ? monthRange(repMonth) : { from: repFrom, to: repTo };
      const rep = await fetchMileageReport(user, {
        ...range,
        agency_id: repAgency,
      });
      setReport(rep);
    } catch (err) {
      setError(errText(err, "Could not generate the report."));
    } finally {
      setRepBusy(false);
    }
  };

  // ---------- render ----------

  if (!apiConnected) {
    return (
      <section>
        <div className="page-head">
          <h1>Mileage</h1>
        </div>
        <p className="exp-notice">
          The mileage log is stored in the CareTask database — it can't load
          while the API is unreachable.
        </p>
      </section>
    );
  }

  const rateNum = Number(rate) || 0;
  let billable = 0;
  let personal = 0;
  legs.forEach((leg, i) => {
    const kind = legKind(stops[i], stops[i + 1], leg.kind_override);
    const mi = Number(leg.miles) || 0;
    if (kind === "commute") personal += mi;
    else billable += mi;
  });
  const anyStopShown = stops.some(
    (s) => showBookends || (s.kind !== "home" && s.kind !== "office"),
  );
  // Deploy-41: policy receipt violations on the generated
  // report, keyed "kind:id" for leg/line markers.
  const violationKeys = new Set(
    (report?.receipt_violations ?? []).map((v) => `${v.kind}:${v.id}`),
  );
  const receiptWarn = (kind: "mileage" | "expense", id: number) =>
    violationKeys.has(`${kind}:${id}`) ? (
      <span className="exp-receipt-warn">
        <AlertTriangle size={13} /> Receipt required
      </span>
    ) : null;
  // Per-row insert (+ at the end of a list row, Jake,
  // 2026-11-06) is offered where the new stop lands
  // inside the visits region: on every patient/custom
  // stop, and on the OPENING Office — the chain's head
  // office, i.e. stops[0], or stops[1] when a Home leads
  // — where inserting below it adds the first visit. It
  // is not offered on the opening Home when an Office
  // follows it (a stop there would split the fixed
  // Home→Office commute leg), nor on the closing
  // bookends (closing Office / closing Home), where the
  // chain-end Add already appends inside the template.
  const headOfficeIdx =
    stops[0]?.kind === "office"
      ? 0
      : stops[0]?.kind === "home" && stops[1]?.kind === "office"
        ? 1
        : -1;
  // Insert-below (+) eligibility — ONE implementation
  // shared by the list rows and the desktop table rows:
  // the new stop must land inside the visits region,
  // i.e. below a patient/custom stop or below the
  // opening Office (headOfficeIdx).
  const canInsertAfter = (s: Stop, idx: number) =>
    isDraggableStop(s) || idx === headOfficeIdx;

  return (
    <section>
      <div className="page-head">
        <h1>Mileage</h1>
        <p className="page-sub">
          Log the day's drive as a chain — home and office bookends are
          personal; the stops between them are billable.
        </p>
      </div>

      {error && <p className="exp-error">{error}</p>}
      {notice && <p className="exp-notice">{notice}</p>}

      <div className="mlg-controls card">
        <label>
          Date
          <input
            type="date"
            value={date}
            onChange={(e) => void switchDay(e.target.value, agencyId)}
          />
        </label>
        <label>
          Agency
          <select
            value={agencyId ?? ""}
            onChange={(e) =>
              void switchDay(date, e.target.value ? Number(e.target.value) : null)
            }
          >
            {(agencies ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Rate ($/mi)
          <input
            type="number"
            min="0"
            step="0.01"
            value={rate}
            onChange={(e) => {
              rateEditedDateRef.current = date;
              setRate(e.target.value);
              setDirty(true);
            }}
          />
          <span className="mlg-hint">
            {rateSource === "table"
              ? "Rate from the rate table for this date"
              : "No rate in the table for this date — using your saved rate"}
          </span>
        </label>
        {dayLoaded && loadedIds.length === 0 && (
          <button
            type="button"
            className="btn"
            onClick={() => void fillFromCalendar()}
            disabled={filling || busy}
            title="Build today's stops from your scheduled visits, in time order"
          >
            <CalendarPlus size={16} /> {filling ? "Filling…" : "Fill from calendar"}
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void saveDay()}
          disabled={busy || !dayLoaded}
        >
          <Check size={16} /> {busy ? "Saving…" : "Save day log"}
        </button>
      </div>

      <div className="card mlg-chain">
        <div className="mlg-chain-head">
          <span className="mlg-chain-title">Stops</span>
          <label
            className="mlg-bookends-toggle"
            title="Show or hide the fixed Home / Office bookend stops"
          >
            <input
              type="checkbox"
              checked={showBookends}
              onChange={(e) => toggleBookends(e.target.checked)}
            />
            Bookends
          </label>
        </div>
        {!dayLoaded && <p className="mlg-empty">Loading the day…</p>}
        {dayLoaded && stops.length === 0 && (
          <p className="mlg-empty">
            No stops yet. Add your first stop below — pick a patient, tap
            Home or Office, or type any address.
          </p>
        )}
        {dayLoaded &&
          stops.length > 0 &&
          !stops.some((s) => showBookends || (s.kind !== "home" && s.kind !== "office")) && (
            <p className="mlg-empty">
              Only bookends on this day, and they're hidden — turn on
              Bookends above to see them, or add a stop below.
            </p>
          )}
        {wideChain && anyStopShown ? (
          <div className="mlg-table-wrap">
            <table className="mlg-table">
              <colgroup>
                <col className="mlg-col-grip" />
                <col className="mlg-col-kind" />
                <col className="mlg-col-stop" />
                <col className="mlg-col-addr" />
                <col className="mlg-col-leg" />
                <col className="mlg-col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="Reorder" />
                  <th>Kind</th>
                  <th>Stop</th>
                  <th>Address</th>
                  <th>Leg in</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {stops.map((stop, i) => {
                  const stopShown =
                    showBookends || (stop.kind !== "home" && stop.kind !== "office");
                  if (!stopShown) return null;
                  // "Leg in": the leg arriving at this stop
                  // (legs[i - 1]). This stop is visible, so
                  // the leg renders even when the stop it
                  // departs from is a hidden bookend — the
                  // same rule the list applies; a leg between
                  // two hidden bookends belongs to a hidden
                  // row and never appears.
                  const legIn = i > 0 ? legs[i - 1] : undefined;
                  const legInKind = legIn
                    ? legKind(stops[i - 1], stop, legIn.kind_override)
                    : null;
                  const dragging = dragKey === stop.key;
                  const editing = editingKey === stop.key;
                  // Click-to-edit parity with the list
                  // (Jake, 2026-11-06): the cell that
                  // displays the address is the tap target
                  // opening the editor row below; when
                  // there's no address, the Stop cell
                  // (label) is the target instead — the
                  // list's fallback. While this row is
                  // being edited, content renders plain.
                  const addrInAddrCell = Boolean(stop.label && stop.address);
                  const stopText = stop.label || stop.address || "New stop";
                  const addrText = stop.label
                    ? stop.address || "—"
                    : stop.address
                      ? "—"
                      : "Tap Edit to set this stop.";
                  const tapCell = (content: React.ReactNode) =>
                    editing ? (
                      content
                    ) : (
                      <button
                        type="button"
                        className="mlg-stop-tap"
                        onClick={() => setEditingKey(stop.key)}
                        title="Tap to edit this stop"
                      >
                        {content}
                      </button>
                    );
                  const kindLabel =
                    stop.kind === "home"
                      ? "Home"
                      : stop.kind === "office"
                        ? "Office"
                        : stop.kind === "patient"
                          ? "Patient"
                          : "Custom";
                  return (
                    <Fragment key={stop.key}>
                      <tr
                        ref={(el) => {
                          if (el) rowRefs.current.set(stop.key, el);
                          else rowRefs.current.delete(stop.key);
                        }}
                        className={dragging ? "mlg-trow-dragging" : undefined}
                      >
                        <td className="mlg-table-grip">
                          {isDraggableStop(stop) && !editingKey && (
                            <button
                              type="button"
                              className="mlg-grip"
                              aria-label="Drag to reorder this stop"
                              title="Drag to reorder"
                              onPointerDown={(e) => onDragHandleDown(e, stop)}
                            >
                              <GripVertical size={16} />
                            </button>
                          )}
                        </td>
                        <td>
                          <span className="mlg-stop-kind">{kindLabel}</span>
                        </td>
                        <td className="mlg-table-stop">
                          {addrInAddrCell ? (
                            <strong>{stopText}</strong>
                          ) : (
                            tapCell(<strong>{stopText}</strong>)
                          )}
                        </td>
                        <td
                          className="mlg-table-addr"
                          title={addrInAddrCell ? undefined : stop.address || undefined}
                        >
                          {addrInAddrCell ? tapCell(addrText) : addrText}
                        </td>
                        <td className="mlg-table-leg">
                          {legIn && legInKind ? (
                            <div className="mlg-table-legcell">
                              <span className="mlg-leg-miles">
                                <MilesEdit
                                  value={effMiles(legIn)}
                                  routedValue={routedFor(legIn)}
                                  onCommit={(v) =>
                                    updateLeg(i - 1, { miles: String(v) })
                                  }
                                />
                              </span>
                              {legInKind === "business" ? (
                                <label
                                  className="mlg-toll"
                                  title="Checked: the tollway route's miles count. Unchecked: back roads."
                                >
                                  <input
                                    type="checkbox"
                                    checked={legIn.used_tollway}
                                    onChange={(e) =>
                                      toggleTollway(i - 1, e.target.checked)
                                    }
                                  />
                                  Tollway
                                </label>
                              ) : (
                                <span className="mlg-hint">
                                  Fixed — set by the addresses
                                </span>
                              )}
                              <span className="mlg-leg-note">
                                {legIn.routing
                                  ? "Routing…"
                                  : legIn.route_failed
                                    ? "Routing unavailable — type the miles."
                                    : legIn.miles_toll !== null ||
                                        legIn.miles_no_toll !== null
                                      ? `Tollway ${legIn.miles_toll ?? "—"} · Back roads ${legIn.miles_no_toll ?? "—"}`
                                      : ""}
                              </span>
                              <button
                                type="button"
                                className={`mlg-badge ${legInKind === "commute" ? "mlg-badge-pers" : "mlg-badge-bill"}`}
                                onClick={() =>
                                  updateLeg(i - 1, {
                                    kind_override:
                                      legInKind === "commute" ? "business" : "commute",
                                  })
                                }
                                title="Tap to switch billable / personal"
                              >
                                {legInKind === "commute" ? "Personal" : "Billable"}
                              </button>
                              <ReceiptsPanel
                                user={user}
                                kind="mileage"
                                lineId={legIn.saved_id}
                                initialCount={legIn.receipt_count}
                                onCountChange={(n) =>
                                  setLegs((prev) =>
                                    prev.map((l, j) =>
                                      j === i - 1 ? { ...l, receipt_count: n } : l,
                                    ),
                                  )
                                }
                              />
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="mlg-table-actions">
                          {!editing && (
                            <div className="mlg-stop-actions">
                              {canInsertAfter(stop, i) && (
                                <button
                                  type="button"
                                  className="mlg-ticon"
                                  onClick={() => insertStopAfter(i)}
                                  aria-label="Add a stop below"
                                  title="Add a stop below"
                                >
                                  <Plus size={16} />
                                </button>
                              )}
                              <button
                                type="button"
                                className="mlg-ticon"
                                onClick={() => setEditingKey(stop.key)}
                                aria-label="Edit"
                                title="Edit"
                              >
                                <Pencil size={16} />
                              </button>
                              <button
                                type="button"
                                className="mlg-ticon"
                                onClick={() => removeStop(stop.key)}
                                aria-label="Delete"
                                title="Delete"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                      {editing && (
                        <tr className="mlg-table-editor-row">
                          <td colSpan={6}>
                            <StopEditor
                              stop={stop}
                              patients={people}
                              homeStop={homeStop}
                              officeStop={() => officeStop(agency)}
                              onDone={(s) => updateStop(stop.key, s)}
                              onCancel={() => setEditingKey(null)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          stops.map((stop, i) => {
          const stopShown =
            showBookends || (stop.kind !== "home" && stop.kind !== "office");
          const next = stops[i + 1];
          const legShown =
            i < legs.length &&
            next !== undefined &&
            (stopShown ||
              showBookends ||
              (next.kind !== "home" && next.kind !== "office"));
          const dragging = dragKey === stop.key;
          return (
            <div
              key={stop.key}
              ref={(el) => {
                if (el) rowRefs.current.set(stop.key, el);
                else rowRefs.current.delete(stop.key);
              }}
              className={dragging ? "mlg-row-dragging" : undefined}
              style={
                dragging
                  ? {
                      transform: `translateY(${dragDy}px)`,
                      position: "relative",
                      zIndex: 5,
                    }
                  : undefined
              }
            >
              {stopShown && (
                <StopRow
                  stop={stop}
                  patients={people}
                  homeStop={homeStop}
                  officeStop={() => officeStop(agency)}
                  editing={editingKey === stop.key}
                  onEdit={() => setEditingKey(stop.key)}
                  onDone={(s) => updateStop(stop.key, s)}
                  onCancel={() => setEditingKey(null)}
                  onRemove={() => removeStop(stop.key)}
                  onInsert={
                    canInsertAfter(stop, i)
                      ? () => insertStopAfter(i)
                      : undefined
                  }
                  onDragStart={
                    isDraggableStop(stop) && !editingKey
                      ? (e) => onDragHandleDown(e, stop)
                      : undefined
                  }
                />
              )}
              {legShown && (
                <LegRow
                  leg={legs[i]}
                  user={user}
                  kind={legKind(stop, next, legs[i].kind_override)}
                  onToggle={(t) => toggleTollway(i, t)}
                  onMilesCommit={(v) => updateLeg(i, { miles: String(v) })}
                  onKind={(k) => updateLeg(i, { kind_override: k })}
                  onReceiptCount={(n) =>
                    // Receipt changes persist server-side on
                    // their own — they must not dirty the day.
                    setLegs((prev) =>
                      prev.map((l, j) =>
                        j === i ? { ...l, receipt_count: n } : l,
                      ),
                    )
                  }
                />
              )}
            </div>
          );
          })
        )}
        <div className="mlg-addstop">
          <button
            type="button"
            className="btn mlg-addstop-btn"
            onClick={addStop}
            aria-label="Add a stop"
            title="Add a stop"
          >
            <Plus size={18} />
            <span className="mlg-addstop-text">Add a stop</span>
          </button>
          <span className="mlg-hint">
            Pick a patient, tap Home/Office, or type any address — each new
            stop chains from the one before it.
          </span>
        </div>
      </div>

      <div className="mlg-totals">
        <div className="mlg-total mlg-total-hero">
          <span>Billable</span>
          <strong>{round2(billable)} mi</strong>
        </div>
        <div className="mlg-total">
          <span>Personal (fixed)</span>
          <strong>{round2(personal)} mi</strong>
        </div>
        <div className="mlg-total">
          <span>Driven</span>
          <strong>{round2(billable + personal)} mi</strong>
        </div>
        <div className="mlg-total">
          <span>Reimbursement</span>
          <strong>{money(Math.round(billable * rateNum * 100))}</strong>
        </div>
      </div>

      <div className="card mlg-otherexp">
        <h2>Other expenses</h2>
        <p className="mlg-hint">
          Itemized lines for {prettyDate(date)} — tolls, parking, meals,
          supplies. Attach receipts with the paperclip on each line.
        </p>
        {expError && <p className="exp-error">{expError}</p>}
        {dayExpenses === null && <p className="mlg-empty">Loading…</p>}
        {dayExpenses !== null && dayExpenses.length === 0 && (
          <p className="mlg-empty">No other expenses logged for this day.</p>
        )}
        {(dayExpenses ?? []).map((line) => (
          <div key={line.id} className="mlg-day-leg exp-line-row">
            <span>
              <strong>{expenseCategoryLabel(line.category)}</strong>
              {line.description ? ` · ${line.description}` : ""}
              {line.vendor_name ? ` · ${line.vendor_name}` : ""}
              {line.notes ? ` · ${line.notes}` : ""}
            </span>
            <span className="exp-line-actions">
              <strong>{money(line.amount_cents)}</strong>
              <ReceiptsPanel
                user={user}
                kind="expense"
                lineId={line.id}
                initialCount={line.receipt_count ?? 0}
                onCountChange={(n) =>
                  setDayExpenses((prev) =>
                    (prev ?? []).map((l) =>
                      l.id === line.id ? { ...l, receipt_count: n } : l,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="mlg-ticon"
                onClick={() => editExpenseLine(line)}
                aria-label="Edit expense"
                title="Edit"
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                className="mlg-ticon"
                onClick={() => void removeExpenseLine(line)}
                disabled={expBusy}
                aria-label="Delete expense"
                title="Delete"
              >
                <Trash2 size={15} />
              </button>
            </span>
          </div>
        ))}
        <form
          className="add-form exp-line-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveExpenseLine();
          }}
        >
          <h3>{expEditingId !== null ? "Edit expense" : "Add an expense"}</h3>
          <div className="form-row">
            <label>
              Date
              <input
                type="date"
                value={expDate}
                onChange={(e) => setExpDate(e.target.value)}
              />
            </label>
            <label>
              Category
              <select
                value={expCategory}
                onChange={(e) => setExpCategory(e.target.value)}
              >
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Amount ($)
              <input
                type="number"
                min="0"
                step="0.01"
                value={expAmount}
                onChange={(e) => setExpAmount(e.target.value)}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Vendor
              <input
                type="text"
                value={expVendor}
                onChange={(e) => setExpVendor(e.target.value)}
              />
            </label>
            <label>
              Description
              <input
                type="text"
                value={expDesc}
                onChange={(e) => setExpDesc(e.target.value)}
              />
            </label>
          </div>
          <label>
            Note
            <input
              type="text"
              value={expNotes}
              onChange={(e) => setExpNotes(e.target.value)}
            />
          </label>
          <div className="flag-actions">
            <button type="submit" className="btn btn-primary" disabled={expBusy}>
              {expBusy
                ? "Saving…"
                : expEditingId !== null
                  ? "Save expense"
                  : "Add expense"}
            </button>
            {expEditingId !== null && (
              <button
                type="button"
                className="btn"
                onClick={resetExpForm}
                disabled={expBusy}
              >
                Cancel edit
              </button>
            )}
          </div>
        </form>
      </div>

      <div className="card mlg-report" ref={reportCardRef}>
        <h2>Expense report</h2>
        <div className="mlg-controls">
          <label>
            Period
            <select
              value={repMode}
              onChange={(e) => setRepMode(e.target.value as "month" | "range")}
            >
              <option value="month">Month</option>
              <option value="range">Date range</option>
            </select>
          </label>
          {repMode === "month" ? (
            <label>
              Month
              <input
                type="month"
                value={repMonth}
                onChange={(e) => setRepMonth(e.target.value)}
              />
            </label>
          ) : (
            <>
              <label>
                From
                <input
                  type="date"
                  value={repFrom}
                  onChange={(e) => setRepFrom(e.target.value)}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={repTo}
                  onChange={(e) => setRepTo(e.target.value)}
                />
              </label>
            </>
          )}
          <label>
            Agency
            <select
              value={repAgency ?? ""}
              onChange={(e) =>
                setRepAgency(e.target.value ? Number(e.target.value) : null)
              }
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
            onClick={() => void generateReport()}
            disabled={repBusy}
          >
            {repBusy ? "Generating…" : "Generate"}
          </button>
          {report && (
            <button type="button" className="btn" onClick={() => window.print()}>
              <Printer size={16} /> Print / PDF
            </button>
          )}
          {report && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void saveAsReport()}
              disabled={repBusy}
            >
              {repBusy ? "Saving…" : "Save as report"}
            </button>
          )}
        </div>
        {repError && <p className="exp-error">{repError}</p>}
        {repNotice && <p className="exp-notice">{repNotice}</p>}

        {report && (
          <div className="mlg-print">
            <h3>
              Mileage report — {prettyDate(report.from)} to {prettyDate(report.to)}
              {report.clinician_name ? ` · ${report.clinician_name}` : ""}
            </h3>
            {report.policy?.require_receipts &&
              (report.receipt_violations?.length ?? 0) > 0 && (
                <p className="exp-receipt-summary">
                  <AlertTriangle size={14} /> {report.receipt_violations.length}{" "}
                  {report.receipt_violations.length === 1 ? "line is" : "lines are"}{" "}
                  missing required receipts — this report can't be submitted
                  until they're attached
                </p>
              )}
            {report.days.length === 0 && (
              <p className="mlg-empty">No mileage logged in this period.</p>
            )}
            {report.days.map((d) => (
              <div key={d.date} className="mlg-day">
                <div className="mlg-day-head">
                  <strong>{prettyDate(d.date)}</strong>
                  <span>
                    Billable {d.billable_miles} mi · Personal {d.personal_miles} mi ·{" "}
                    {money(d.amount_cents)}
                  </span>
                </div>
                {d.legs.map((l) => (
                  <div key={l.id} className="mlg-day-leg">
                    <span>
                      {l.start_address || "—"} →{" "}
                      {l.end_address || "—"}
                      {receiptWarn("mileage", l.id)}
                    </span>
                    <span>
                      {l.business_miles} mi
                      {l.entry_kind === "commute" ? " · personal" : ""}
                      {l.entry_kind === "business" && l.miles_no_toll !== null
                        ? l.used_tollway
                          ? " · tollway"
                          : " · back roads"
                        : ""}
                      {(l.receipt_count ?? 0) > 0
                        ? ` · ${l.receipt_count} receipt${l.receipt_count === 1 ? "" : "s"}`
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {(report.expenses?.length ?? 0) > 0 && (
              <div className="mlg-day">
                <div className="mlg-day-head">
                  <strong>Other expenses</strong>
                  <span>{money(report.expenses_amount_cents ?? 0)}</span>
                </div>
                {(report.expenses ?? []).map((e) => (
                  <div key={e.id} className="mlg-day-leg">
                    <span>
                      {expenseCategoryLabel(e.category)}
                      {e.description ? ` · ${e.description}` : ""}
                      {e.vendor_name ? ` · ${e.vendor_name}` : ""} ·{" "}
                      {prettyDate(e.expense_date)}
                      {receiptWarn("expense", e.id)}
                    </span>
                    <span>
                      {money(e.amount_cents)}
                      {(e.receipt_count ?? 0) > 0
                        ? ` · ${e.receipt_count} receipt${e.receipt_count === 1 ? "" : "s"}`
                        : ""}
                    </span>
                  </div>
                ))}
                <div className="mlg-day-leg">
                  <span>
                    <strong>Expenses subtotal</strong>
                  </span>
                  <span>
                    <strong>{money(report.expenses_amount_cents ?? 0)}</strong>
                  </span>
                </div>
              </div>
            )}
            {report.days.length > 0 && (
              <div className="mlg-day-head mlg-report-total">
                <strong>Totals</strong>
                <span>
                  Billable {report.total_billable_miles} mi · Personal{" "}
                  {report.total_personal_miles} mi · Driven{" "}
                  {report.total_driven_miles} mi ·{" "}
                  <strong>{money(report.total_amount_cents)}</strong>
                </span>
              </div>
            )}
            {(report.days.length > 0 || (report.expenses?.length ?? 0) > 0) && (
              <div className="mlg-day-head">
                <strong>Report totals</strong>
                <span>
                  Mileage {money(report.total_amount_cents)} · Expenses{" "}
                  {money(report.expenses_amount_cents ?? 0)} · Total{" "}
                  <strong>
                    {money(
                      report.grand_total_amount_cents ??
                        report.total_amount_cents +
                          (report.expenses_amount_cents ?? 0),
                    )}
                  </strong>
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <SavedReportsSection
        reports={savedReports}
        detail={detail}
        detailBusy={detailBusy}
        detailError={detailError}
        detailNotice={detailNotice}
        detailViolations={detailViolations}
        rejectNote={rejectNote}
        paymentRef={paymentRef}
        agencies={agencies ?? []}
        me={me}
        onOpen={(id) => void openSavedReport(id)}
        onClose={() => setDetail(null)}
        onRejectNote={setRejectNote}
        onPaymentRef={setPaymentRef}
        onTransition={(to) => void doTransition(to)}
      />
    </section>
  );
}

// ---------- stop row + editor ----------

function StopRow({
  stop,
  patients,
  homeStop,
  officeStop,
  editing,
  onEdit,
  onDone,
  onCancel,
  onRemove,
  onInsert,
  onDragStart,
}: {
  stop: Stop;
  patients: PersonUnderCare[];
  homeStop: () => Promise<Stop | null>;
  officeStop: (() => Promise<Stop | null>) | null;
  editing: boolean;
  onEdit: () => void;
  onDone: (s: Stop) => void;
  onCancel: () => void;
  onRemove: () => void;
  onInsert?: () => void;
  onDragStart?: (e: React.PointerEvent) => void;
}) {
  // List rows (Jake, 2026-11-06): no kind caption (Patient /
  // Stop) and no Edit button — the stop's ADDRESS is the
  // tap target that opens the editor, with the label as the
  // target when there's no address text to tap. Bookends
  // read as Home/Office through their label. The desktop
  // table keeps its Kind column and Edit button. Rows in
  // the visits region also carry a round + (onInsert)
  // that inserts a new stop directly below the row.
  const addrContent = stop.label ? (
    <span className="mlg-stop-addr">{stop.address}</span>
  ) : (
    <strong>{stop.address}</strong>
  );
  const tapTarget = (content: React.ReactNode) =>
    editing ? (
      content
    ) : (
      <button
        type="button"
        className="mlg-stop-tap"
        onClick={onEdit}
        title="Tap to edit this stop"
      >
        {content}
      </button>
    );
  return (
    <div className="mlg-stop">
      {onDragStart && !editing && (
        <button
          type="button"
          className="mlg-grip"
          aria-label="Drag to reorder this stop"
          title="Drag to reorder"
          onPointerDown={onDragStart}
        >
          <GripVertical size={16} />
        </button>
      )}
      <div className="mlg-stop-main">
        {stop.address ? (
          <>
            {stop.label && <strong>{stop.label}</strong>}
            {tapTarget(addrContent)}
          </>
        ) : stop.label ? (
          tapTarget(<strong>{stop.label}</strong>)
        ) : (
          tapTarget(<span className="mlg-stop-addr">Tap to set this stop.</span>)
        )}
      </div>
      {!editing && (
        <div className="mlg-stop-actions">
          {onInsert && (
            <button
              type="button"
              className="mlg-stop-add"
              onClick={onInsert}
              aria-label="Add a stop below this one"
              title="Add a stop below"
            >
              <Plus size={16} />
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={onRemove} aria-label="Remove stop">
            <Trash2 size={14} />
          </button>
        </div>
      )}
      {editing && (
        <StopEditor
          stop={stop}
          patients={patients}
          homeStop={homeStop}
          officeStop={officeStop}
          onDone={onDone}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

function StopEditor({
  stop,
  patients,
  homeStop,
  officeStop,
  onDone,
  onCancel,
}: {
  stop: Stop;
  patients: PersonUnderCare[];
  homeStop: () => Promise<Stop | null>;
  officeStop: (() => Promise<Stop | null>) | null;
  onDone: (s: Stop) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Stop>(stop);
  const [addrText, setAddrText] = useState(stop.address);
  const [patientQuery, setPatientQuery] = useState("");
  const [pickError, setPickError] = useState("");
  const [locating, setLocating] = useState(false);
  const [nearNote, setNearNote] = useState("");

  const matches = patientQuery.trim()
    ? patients
        .filter((p) =>
          `${p.lname ?? ""} ${p.fname ?? ""} ${p.name}`
            .toLowerCase()
            .includes(patientQuery.toLowerCase()),
        )
        .slice(0, 6)
    : [];

  const pickPatient = (p: PersonUnderCare) => {
    const address = joinAddress(p.street, p.city, p.state, p.postalCode);
    setDraft({
      ...draft,
      kind: "patient",
      label: p.lname && p.fname ? `${p.lname}, ${p.fname}` : p.name,
      address,
      lat: p.latitude ?? null,
      lng: p.longitude ?? null,
      patient_id: p.id,
    });
    setAddrText(address);
    setPatientQuery("");
  };

  // Location icon: one GPS fix, then fill the box with the
  // CLOSEST PATIENT HOME's address (Jake's pick, 2026-11-06:
  // auto-fill the nearest — no chooser). The filled address is
  // the house's own address from the patient record. Patients
  // without stored coordinates can't be matched.
  // Fallback (Jake, 2026-11-06, later the same day): when NO
  // patient home is within ~2 mi — including lists with no
  // patients at all — the button must not dead-end. It inserts
  // the clinician's CURRENT location instead: the GPS point
  // reverse-geocoded to a street address, placed in the
  // Address box (Jake: an address, never coordinate text —
  // reports show addresses only). If the exact spot has no
  // road-level match, progressively wider lookups find the
  // nearest road's address. The stop still carries the GPS
  // coordinates in its lat/lng, so routing keeps full
  // precision; only the visible address is the street address.
  const fillNearest = () => {
    setPickError("");
    setNearNote("");
    if (!("geolocation" in navigator)) {
      setPickError("Location isn't available in this browser — search by name or type the address.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        let best: { p: PersonUnderCare; d: number } | null = null;
        for (const p of patients) {
          if (typeof p.latitude !== "number" || typeof p.longitude !== "number") continue;
          const d = haversineMiles(here, { lat: p.latitude, lon: p.longitude });
          if (!best || d < best.d) best = { p, d };
        }
        if (!best || best.d > 2) {
          let street: string | null = null;
          for (const zoom of [18, 16, 14]) {
            street = await reverseGeocode(here.lat, here.lon, zoom);
            if (street) break;
          }
          setLocating(false);
          if (!street) {
            // Not an error (Jake, 2026-11-06): with no address
            // to insert, the normal path is simply typing one.
            // Leave the draft and the box untouched, say so
            // in a neutral note, and let them type.
            setNearNote("No patient home near and no address found for your spot — just type the address.");
            return;
          }
          setDraft((d) => ({
            ...d,
            kind: "custom",
            label: "",
            address: street,
            lat: here.lat,
            lng: here.lon,
            patient_id: null,
          }));
          setAddrText(street);
          setNearNote("No patient home near — inserted the address for where you are now.");
          return;
        }
        setLocating(false);
        pickPatient(best.p);
        const name =
          best.p.lname && best.p.fname ? `${best.p.lname}, ${best.p.fname}` : best.p.name;
        setNearNote(
          `Nearest home: ${name} · ${best.d < 0.05 ? "under 0.1" : best.d.toFixed(1)} mi away`,
        );
      },
      () => {
        setLocating(false);
        setPickError(
          "Couldn't get your location — check this site's location permission, or search by name.",
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  };

  const pickKnown = async (which: "home" | "office") => {
    setPickError("");
    const s = which === "home" ? await homeStop() : officeStop ? await officeStop() : null;
    if (!s) {
      setPickError(
        which === "home"
          ? "No home address on your staff profile yet — add it in Settings → Home & Office."
          : "No office address available — add yours in Settings → Home & Office, or pick an agency with an address on file.",
      );
      return;
    }
    setDraft({ ...s, key: draft.key });
    setAddrText(s.address);
  };

  return (
    <div className="mlg-editor">
      <div className="mlg-chips">
        <button type="button" className="btn btn-small" onClick={() => void pickKnown("home")}>
          <Home size={14} /> Home
        </button>
        <button type="button" className="btn btn-small" onClick={() => void pickKnown("office")}>
          <Building2 size={14} /> Office
        </button>
        <span className="mlg-hint">…or find a patient, or type any address:</span>
      </div>
      {pickError && <p className="exp-error">{pickError}</p>}
      <input
        type="text"
        placeholder="Search patients by name…"
        value={patientQuery}
        onChange={(e) => setPatientQuery(e.target.value)}
      />
      {matches.length > 0 && (
        <div className="mlg-patient-results">
          {matches.map((p) => (
            <button key={p.id} type="button" onClick={() => pickPatient(p)}>
              <strong>
                {p.lname && p.fname ? `${p.lname}, ${p.fname}` : p.name}
              </strong>
              <span>{joinAddress(p.street, p.city, p.state, p.postalCode)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="form-field">
        <span>Address</span>
        <div className="mlg-addr-row">
        <AddressAutocomplete
          value={addrText}
          onChange={(v) => {
            setAddrText(v);
            // Typing over a picked patient turns the stop into
            // a plain address stop; Home/Office keep their
            // labels (their profile address is being edited).
            setDraft((d) => ({
              ...d,
              kind: d.kind === "patient" ? "custom" : d.kind,
              address: v,
              lat: null,
              lng: null,
              patient_id: null,
              label: d.kind === "patient" ? "" : d.label,
            }));
          }}
          onSelectAddress={(a: SuggestedAddress) => {
            const address = suggestedToAddress(a);
            setAddrText(address);
            setDraft((d) => ({
              ...d,
              kind: d.kind === "patient" ? "custom" : d.kind,
              address,
              lat: a.latitude,
              lng: a.longitude,
              patient_id: null,
              label: d.kind === "patient" ? "" : d.label,
            }));
          }}
        />
        <button
          type="button"
          className="btn mlg-locate-btn"
          onClick={fillNearest}
          disabled={locating}
          title="Fill with the closest patient home, or your current location"
          aria-label="Fill with the closest patient home, or your current location"
        >
          <LocateFixed size={17} />
        </button>
        </div>
        {locating && <p className="mlg-hint">Locating…</p>}
        {nearNote && (
          <p className="mlg-hint mlg-near-note">
            <MapPin size={13} /> {nearNote}
          </p>
        )}
      </div>
      {(draft.label || draft.address) && (
        <p className="mlg-hint">
          <MapPin size={13} /> {draft.label ? `${draft.label} — ` : ""}
          {draft.address}
          {draft.lat === null ? " (no coordinates — routing unavailable, type the miles)" : ""}
        </p>
      )}
      <div className="mlg-editor-actions">
        <button type="button" className="btn btn-primary" onClick={() => onDone(draft)}>
          <Check size={15} /> Done
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          <X size={15} /> Cancel
        </button>
      </div>
    </div>
  );
}

// ---------- click-to-edit miles ----------
// One component shared by the chain list's LegRow and the
// desktop table's "Leg in" cell (Jake, 2026-11-06): the
// leg's effective miles render as bold text with a dotted
// underline; clicking swaps in a number input with the
// value selected. Enter / blur commits (parseFloat,
// rounded to 2 decimals; empty / non-numeric / negative
// reverts silently); Escape cancels. A commit writes the
// leg's miles field — a manual override of the routed
// figure that every total, save, and report then reads.
// The "Edited" flag is DERIVED, never stored: it shows
// when the effective miles differ from the routed figure
// for the selected route, so re-entering the routed value
// (or toggling the route back) clears it on its own. With
// no routed figure there is nothing to differ from, so no
// flag — e.g. a hand-typed leg whose routing failed.
function MilesEdit({
  value,
  routedValue,
  onCommit,
}: {
  value: number | null;
  routedValue: number | null;
  onCommit: (miles: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const cancelRef = useRef(false);

  const open = () => {
    cancelRef.current = false;
    setDraft(value !== null ? String(value) : "");
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    if (cancelRef.current) return;
    const parsed = parseFloat(draft);
    if (draft.trim() === "" || Number.isNaN(parsed) || parsed < 0) return;
    const next = round2(parsed);
    if (value !== null && next === round2(value)) return;
    onCommit(next);
  };

  if (editing) {
    return (
      <span className="mlg-miles-editwrap">
        <input
          className="mlg-miles-input"
          type="number"
          inputMode="decimal"
          step="0.1"
          min="0"
          value={draft}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              cancelRef.current = true;
              e.currentTarget.blur();
            }
          }}
          aria-label="Leg miles"
        />
        <span>mi</span>
      </span>
    );
  }

  const edited =
    value !== null &&
    routedValue !== null &&
    round2(value) !== round2(routedValue);
  return (
    <span className="mlg-miles-editwrap">
      <button
        type="button"
        className={`mlg-miles-text${value === null ? " mlg-miles-empty" : ""}`}
        title="Edit miles"
        aria-label="Edit miles"
        onClick={open}
      >
        {value !== null ? fmtMi(value) : "0.0"} mi
      </button>
      {edited && (
        <>
          <span className="mlg-miles-flag">Edited</span>
          <span className="mlg-miles-routed">
            Routed was {fmtMi(routedValue)}
          </span>
        </>
      )}
    </span>
  );
}

// ---------- leg row ----------

function LegRow({
  leg,
  user,
  kind,
  onToggle,
  onMilesCommit,
  onKind,
  onReceiptCount,
}: {
  leg: LegState;
  user: User;
  kind: "business" | "commute";
  onToggle: (tollway: boolean) => void;
  onMilesCommit: (v: number) => void;
  onKind: (k: "business" | "commute") => void;
  onReceiptCount: (n: number) => void;
}) {
  return (
    <div className={`mlg-leg${kind === "commute" ? " mlg-leg-fixed" : ""}`}>
      <span className="mlg-arrow">↓</span>
      <div className="mlg-leg-miles">
        <MilesEdit
          value={effMiles(leg)}
          routedValue={routedFor(leg)}
          onCommit={onMilesCommit}
        />
      </div>
      {kind === "business" ? (
        <label className="mlg-toll" title="Checked: the tollway route's miles count. Unchecked: back roads.">
          <input
            type="checkbox"
            checked={leg.used_tollway}
            onChange={(e) => onToggle(e.target.checked)}
          />
          Tollway
        </label>
      ) : (
        <span className="mlg-hint">Fixed — set by the addresses</span>
      )}
      <span className="mlg-leg-note">
        {leg.routing
          ? "Routing…"
          : leg.route_failed
            ? "Routing unavailable — type the miles."
            : leg.miles_toll !== null || leg.miles_no_toll !== null
              ? `Tollway ${leg.miles_toll ?? "—"} · Back roads ${leg.miles_no_toll ?? "—"}`
              : ""}
      </span>
      <button
        type="button"
        className={`mlg-badge ${kind === "commute" ? "mlg-badge-pers" : "mlg-badge-bill"}`}
        onClick={() => onKind(kind === "commute" ? "business" : "commute")}
        title="Tap to switch billable / personal"
      >
        {kind === "commute" ? "Personal" : "Billable"}
      </button>
      <ReceiptsPanel
        user={user}
        kind="mileage"
        lineId={leg.saved_id}
        initialCount={leg.receipt_count}
        onCountChange={onReceiptCount}
      />
    </div>
  );
}

// ---------- saved reports (deploy-41) ----------
// The saved-report list + detail: lifecycle status, chain
// days and itemized lines, the approval timeline, and the
// transition actions. Roles are presentation only (the API
// enforces): the owner submits / returns to draft; managers
// and admins approve, reject, and mark paid — except on
// their OWN reports (SELF_APPROVAL): owners never see the
// approve / reject / mark-paid buttons, only the note that
// another manager or admin processes it. Legacy (pre-chain)
// reports render their summary + a format note, no buttons.

function statusLabel(status: string): string {
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : status;
}

function eventTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function SavedReportsSection({
  reports,
  detail,
  detailBusy,
  detailError,
  detailNotice,
  detailViolations,
  rejectNote,
  paymentRef,
  agencies,
  me,
  onOpen,
  onClose,
  onRejectNote,
  onPaymentRef,
  onTransition,
}: {
  reports: SavedReport[] | null;
  detail: ChainReportDetail | null;
  detailBusy: boolean;
  detailError: string;
  detailNotice: string;
  detailViolations: ReceiptViolation[];
  rejectNote: string;
  paymentRef: string;
  agencies: ApiAgency[];
  me: ApiUser | null | undefined;
  onOpen: (id: number) => void;
  onClose: () => void;
  onRejectNote: (v: string) => void;
  onPaymentRef: (v: string) => void;
  onTransition: (to: "submitted" | "approved" | "rejected" | "draft" | "paid") => void;
}) {
  const manager = isManagerRole(me);
  const rep = detail?.report ?? null;
  const legacy = detail ? detail.model === "legacy" || rep?.model === "legacy" : false;
  const isOwner =
    !!me && !!rep && rep.user_id !== null && rep.user_id !== undefined
      ? String(me.id) === String(rep.user_id)
      : false;
  const status = rep?.status ?? "";
  const agencyName = (id: number | null) =>
    id === null
      ? "All agencies"
      : (agencies.find((a) => a.id === id)?.display_name ?? `Agency #${id}`);
  const listTotal = (r: SavedReport): number | null =>
    r.total_amount_cents ?? r.mileage_amount_cents ?? null;
  const mileageCents =
    detail?.mileage_amount_cents ?? rep?.mileage_amount_cents ?? rep?.total_amount_cents ?? null;
  const expensesCents = detail?.expenses_amount_cents ?? rep?.expenses_amount_cents ?? null;
  const grandCents =
    detail?.total_amount_cents ??
    rep?.total_amount_cents ??
    (mileageCents !== null || expensesCents !== null
      ? (mileageCents ?? 0) + (expensesCents ?? 0)
      : null);

  return (
    <div className="card mlg-report">
      <h2>Saved reports</h2>
      {reports === null && <p className="mlg-empty">Loading…</p>}
      {reports !== null && reports.length === 0 && (
        <p className="mlg-empty">
          No saved reports yet — generate a report above and choose "Save as
          report".
        </p>
      )}
      <div className="exp-list">
        {(reports ?? []).map((r) => {
          const total = listTotal(r);
          return (
            <button
              key={r.id}
              type="button"
              className="exp-row"
              onClick={() => onOpen(r.id)}
            >
              <span className="exp-row-main">
                <strong>
                  {r.title ||
                    `Report ${prettyDate(r.period_start)} to ${prettyDate(r.period_end)}`}
                </strong>
                <span className="exp-row-sub">
                  {prettyDate(r.period_start)} to {prettyDate(r.period_end)} ·{" "}
                  {agencyName(r.agency_id)}
                  {total !== null ? ` · ${money(total)}` : ""}
                  {r.model === "legacy" ? " · Legacy" : ""}
                </span>
              </span>
              <span className={`exp-status exp-status-${r.status}`}>
                {statusLabel(String(r.status))}
              </span>
            </button>
          );
        })}
      </div>

      {detailBusy && !detail && <p className="mlg-empty">Opening report…</p>}
      {detailError && <p className="exp-error">{detailError}</p>}

      {detail && rep && (
        <div className="exp-detail">
          <div className="mlg-day-head">
            <strong>
              {rep.title ||
                `Report ${prettyDate(rep.period_start)} to ${prettyDate(rep.period_end)}`}
            </strong>
            <span>
              {prettyDate(rep.period_start)} to {prettyDate(rep.period_end)} ·{" "}
              {agencyName(rep.agency_id)}{" "}
              <span className={`exp-status exp-status-${rep.status}`}>
                {statusLabel(String(rep.status))}
              </span>
            </span>
          </div>
          <button type="button" className="btn btn-small" onClick={onClose}>
            <X size={14} /> Close
          </button>
          {legacy && (
            <p className="exp-notice">
              Legacy report (pre-chain format) — summary numbers only; this
              report predates the day-chain log and itemized expenses.
            </p>
          )}
          <div className="mlg-totals exp-detail-totals">
            {(detail.total_billable_miles ?? rep.total_billable_miles) != null && (
              <div className="mlg-total">
                <span>Billable</span>
                <strong>
                  {detail.total_billable_miles ?? rep.total_billable_miles} mi
                </strong>
              </div>
            )}
            {(detail.total_personal_miles ?? rep.total_personal_miles) != null && (
              <div className="mlg-total">
                <span>Personal</span>
                <strong>
                  {detail.total_personal_miles ?? rep.total_personal_miles} mi
                </strong>
              </div>
            )}
            {(detail.total_driven_miles ?? rep.total_driven_miles) != null && (
              <div className="mlg-total">
                <span>Driven</span>
                <strong>
                  {detail.total_driven_miles ?? rep.total_driven_miles} mi
                </strong>
              </div>
            )}
            {mileageCents !== null && (
              <div className="mlg-total">
                <span>Mileage</span>
                <strong>{money(mileageCents)}</strong>
              </div>
            )}
            {expensesCents !== null && (
              <div className="mlg-total">
                <span>Expenses</span>
                <strong>{money(expensesCents)}</strong>
              </div>
            )}
            {grandCents !== null && (
              <div className="mlg-total mlg-total-hero">
                <span>Total</span>
                <strong>{money(grandCents)}</strong>
              </div>
            )}
          </div>

          {!legacy &&
            (detail.days ?? []).map((d) => (
              <div key={d.date} className="mlg-day">
                <div className="mlg-day-head">
                  <strong>{prettyDate(d.date)}</strong>
                  <span>
                    Billable {d.billable_miles} mi · Personal {d.personal_miles}{" "}
                    mi · {money(d.amount_cents)}
                  </span>
                </div>
                {d.legs.map((l) => (
                  <div key={l.id} className="mlg-day-leg">
                    <span>
                      {l.start_address || "—"} → {l.end_address || "—"}
                    </span>
                    <span>
                      {l.business_miles} mi
                      {l.entry_kind === "commute" ? " · personal" : ""}
                      {(l.receipt_count ?? 0) > 0
                        ? ` · ${l.receipt_count} receipt${l.receipt_count === 1 ? "" : "s"}`
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            ))}

          {!legacy && (detail.expenses?.length ?? 0) > 0 && (
            <div className="mlg-day">
              <div className="mlg-day-head">
                <strong>Other expenses</strong>
                <span>{expensesCents !== null ? money(expensesCents) : ""}</span>
              </div>
              {(detail.expenses ?? []).map((e) => (
                <div key={e.id} className="mlg-day-leg">
                  <span>
                    {expenseCategoryLabel(e.category)}
                    {e.description ? ` · ${e.description}` : ""}
                    {e.vendor_name ? ` · ${e.vendor_name}` : ""} ·{" "}
                    {prettyDate(e.expense_date)}
                  </span>
                  <span>
                    {money(e.amount_cents)}
                    {(e.receipt_count ?? 0) > 0
                      ? ` · ${e.receipt_count} receipt${e.receipt_count === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          <h3 className="exp-timeline-title">Approval timeline</h3>
          {(detail.events ?? []).length === 0 && (
            <p className="mlg-hint">No activity recorded yet.</p>
          )}
          <div className="exp-timeline">
            {(detail.events ?? []).map((ev) => (
              <div key={ev.id} className="exp-timeline-row">
                <span>
                  <strong>{ev.actor_name || "System"}</strong>{" "}
                  {ev.from_status === null
                    ? "Created"
                    : `${statusLabel(ev.from_status)} → ${statusLabel(ev.to_status)}`}
                  {ev.note ? ` — ${ev.note}` : ""}
                </span>
                <span className="mlg-hint">{eventTime(ev.created_at)}</span>
              </div>
            ))}
          </div>

          {detailViolations.length > 0 && (
            <div className="exp-receipt-summary">
              <AlertTriangle size={14} /> Receipts are required before this
              report can move forward. Blocking lines:
              <ul>
                {detailViolations.map((v) => (
                  <li key={`${v.kind}-${v.id}`}>
                    {v.kind === "mileage" ? "Mileage leg" : "Expense line"} #
                    {v.id} — {prettyDate(v.date)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detailNotice && <p className="exp-notice">{detailNotice}</p>}

          {!legacy && (
            <div className="exp-actions">
              {isOwner && status === "draft" && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={detailBusy}
                  onClick={() => onTransition("submitted")}
                >
                  Submit
                </button>
              )}
              {isOwner && status === "rejected" && (
                <button
                  type="button"
                  className="btn"
                  disabled={detailBusy}
                  onClick={() => onTransition("draft")}
                >
                  Return to draft
                </button>
              )}
              {isOwner && (status === "submitted" || status === "approved") && (
                <p className="section-note">
                  You can't approve your own report — another manager or admin
                  processes it.
                </p>
              )}
              {manager && !isOwner && status === "submitted" && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={detailBusy}
                    onClick={() => onTransition("approved")}
                  >
                    Approve
                  </button>
                  <input
                    type="text"
                    className="exp-inline-input"
                    placeholder="Rejection note (optional)"
                    value={rejectNote}
                    onChange={(e) => onRejectNote(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={detailBusy}
                    onClick={() => onTransition("rejected")}
                  >
                    Reject
                  </button>
                </>
              )}
              {manager && !isOwner && status === "approved" && (
                <>
                  <input
                    type="text"
                    className="exp-inline-input"
                    placeholder="Payment reference (optional)"
                    value={paymentRef}
                    onChange={(e) => onPaymentRef(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={detailBusy}
                    onClick={() => onTransition("paid")}
                  >
                    Mark paid
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
