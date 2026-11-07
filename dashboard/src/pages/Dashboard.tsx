import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut, type User } from "firebase/auth";
import { auth } from "../lib/firebase";
import { COLOR_THEMES, type ColorTheme, type Theme } from "../lib/theme";
import Mark from "../components/Mark";
import AddressAutocomplete from "../components/AddressAutocomplete";
import ExpensesView from "../components/ExpensesView";
import ConcurExportCard from "../components/ConcurExportCard";
import { fetchMileageReport } from "../lib/expensesApi";
import { downloadConcurCsv } from "../lib/concurCsv";
import StateSelect from "../components/StateSelect";
import {
  BarChart3,
  Blocks,
  Building2,
  CalendarCheck,
  CalendarDays,
  ArrowLeft,
  CalendarPlus,
  Cake,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
  Clock,
  Cloud,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  FileText,
  Flag as FlagIcon,
  Filter,
  HeartPulse,
  LayoutDashboard,
  LifeBuoy,
  Mail,
  MapPin,
  Menu,
  Monitor,
  Moon,
  Navigation,
  Pencil,
  Phone,
  Plus,
  Receipt,
  Route,
  Search,
  Settings,
  Siren,
  Smartphone,
  Sun,
  User as UserIcon,
  Users,
  X,
  XCircle,
} from "lucide-react";
import {
  analytics,
  daySchedule,
  initialFlags,
  peopleUnderCare,
  reminders,
  triageTickets,
  ZONE_GUIDE,
  type Flag,
  type FlagDecision,
  type PersonUnderCare,
  type TrafficLight,
} from "../lib/demoData";
import { downloadReportPdf } from "../lib/reportPdf";
import GoogleContactPicker from "../components/GoogleContactPicker";
import {
  callingHref, formatUSPhone, telHref } from "../lib/phone";
import CalendarView from "../components/CalendarView";
import PatientsMapView from "../components/PatientsMapView";
import { toMapPatient } from "../lib/geo";
import MessagesView from "../components/MessagesView";
import PatientMessages from "../components/PatientMessages";
import ClinicalDocuments from "../components/ClinicalDocuments";
import MergeReview from "../components/MergeReview";
import CallingAppSettings from "../components/CallingAppSettings";
import TextIntake from "../components/TextIntake";
import TasksPanel from "../components/TasksPanel";
import NewsCard from "../components/NewsCard";
import NewsTopicsSettings from "../components/NewsTopicsSettings";
import {
  daypartOf,
  fetchWeather,
  seasonOf,
  type WeatherNow,
} from "../lib/overviewClock";
import VisitCategoriesSettings from "../components/VisitCategoriesSettings";
import AgencyView from "../components/AgencyView";
import AgencyPicker from "../components/AgencyPicker";
import AgencyDirectorySettings from "../components/AgencyDirectorySettings";
import CsvImport from "../components/CsvImport";
import { MyAgenciesCard } from "../components/PlatformSettings";
import { HomeOfficeCard } from "../components/HomeOfficeSettings";
import {
  ExpensePolicyCard,
  MileageRatesCard,
} from "../components/ExpenseAdminSettings";
import { PhoneContactsCard } from "../components/PhoneContactsSettings";
import EpisodeCard from "../components/EpisodeCard";
import type { ContactCandidate } from "../lib/googleContacts";
import {
  ageBandFromDob,
  ageFromDob,
  createPatient,
  createStaff,
  deactivateStaff,
  deletePatient,
  linkPatient,
  listClinicians,
  markDuplicatePair,
  getPatient,
  isApiConfigured,
  isRoleRejection,
  listAppointments,
  listEvents,
  listPatients,
  listMessages,
  listUsers,
  reportEvent,
  restoreStaff,
  searchPatients,
  setLinkStatus,
  STAFF_CREDENTIALS,
  STAFF_POSITIONS,
  STAFF_ROLES,
  unlinkPatient,
  updatePatient,
  updateStaff,
  verifyChain,
  type ApiEvent,
  type ApiRequestError,
  type ApiUser,
  type NewApiPatient,
  type AuditEventName,
  type ChainVerification,
  type PatientStatus,
  type StaffInput,
  type StaffRole,
} from "../lib/patientApi";
import { isManagerRole, useMyStaff } from "../lib/useMyRole";

type Tab =
  | "dashboard"
  | "clinician"
  | "list"
  | "profile"
  | "add"
  | "map"
  | "appointment"
  | "messages"
  | "agency"
  | "triage"
  | "flags"
  | "reports"
  | "expenses"
  | "contacts"
  | "settings"
  | "categories"
  | "integrations"
  | "help"
  | "audit";

const PRIORITY_ORDER = { P1: 0, P2: 1, P3: 2 } as const;

// Audit Log page size (matches the API's default limit).
const AUDIT_PAGE_SIZE = 50;

const AUDIT_EVENT_OPTIONS: AuditEventName[] = [
  "patient_view",
  "sign_in",
  "sign_out",
  "report_export",
  "auth_failure",
  "api_request",
  "admin_action",
  "appointment_change",
  "message_send",
  "message_read",
  "document_create",
  "document_update",
  "document_finalize",
];

// Short DOB for the duplicate warning: 1952-03-14 → 03/14/52.
function shortDob(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y.slice(2)}`;
}

// One-line plain-English description of an audit event for the card.
function describeEvent(e: ApiEvent, people: PersonUnderCare[]): string {
  const d = e.details as Record<string, unknown>;
  const patientName = e.patient_id
    ? (people.find((p) => p.id === e.patient_id)?.name ?? e.patient_id)
    : null;
  switch (e.event) {
    case "patient_view":
      return `Viewed ${patientName ?? "a patient record"}`;
    case "sign_in":
      return "Signed in";
    case "sign_out":
      return "Signed out";
    case "report_export":
      return "Exported a report";
    case "auth_failure":
      return `Failed API call: ${String(d.method ?? "")} ${String(d.path ?? "")} → ${String(d.status ?? "")}`;
    case "api_request":
      return `${String(d.method ?? "")} ${String(d.path ?? "")} → ${String(d.status ?? "")}`;
    case "admin_action":
      return "Admin action";
    case "appointment_change": {
      const action = String(d.action ?? "");
      if (action === "appointment_status")
        return `Appointment status: ${String(d.from_status ?? "")} → ${String(d.to_status ?? "")}${patientName ? ` (${patientName})` : ""}`;
      return `Appointment ${action.replace("appointment_", "")}${patientName ? ` — ${patientName}` : ""}`;
    }
    case "message_send":
      return `Message sent${patientName ? ` — ${patientName}` : ""}`;
    case "message_read":
      return `Message read${patientName ? ` — ${patientName}` : ""}`;
    case "document_create":
      return `Document created${patientName ? ` — ${patientName}` : ""}`;
    case "document_update": {
      const action = String(d.action ?? "");
      if (action === "document_delete")
        return `Document deleted${patientName ? ` — ${patientName}` : ""}`;
      if (action === "document_restore")
        return `Document restored${patientName ? ` — ${patientName}` : ""}`;
      return `Document updated${patientName ? ` — ${patientName}` : ""}`;
    }
    case "document_finalize":
      return `Document finalized${patientName ? ` — ${patientName}` : ""}`;
    default:
      return e.event;
  }
}

// Chain-verification badge text. A broken chain names the first row
// that fails, so the clinician can say exactly where trust stops.
function chainBadge(
  chain: Record<string, ChainVerification> | null,
): string {
  if (!chain) return "";
  const part = (name: string): string => {
    const t = chain[name];
    if (!t) return `${name}: unknown`;
    let s = `${name}: ${t.valid ? "valid" : "BROKEN"} (${t.checked} checked`;
    if (t.legacy) s += `, ${t.legacy} pre-chain`;
    s += ")";
    if (!t.valid && t.first_break) {
      s += ` — first break seq ${t.first_break.seq} (${t.first_break.reason})`;
    }
    return s;
  };
  return `Chain check — ${part("audit_log")} · ${part("event_log")}`;
}

// Patient List display name (Jake, 2026-10-30): "Lastname,
// Firstname" — no title, no middle name. People without split
// name fields (the in-browser demo set) keep their display name.
function listName(p: PersonUnderCare): string {
  if (p.lname && p.fname) return `${p.lname}, ${p.fname}`;
  return p.name;
}

// Compact age/sex, "74/F" (Jake, 2026-10-30): exact age from
// DOB via ageFromDob + sex initial (F/M; other sex values pass
// through as recorded). Age falls back to the stored `age`
// column when there is no usable DOB (Jake, 2026-11-01 — DOB
// is optional now). Returns null when the patient has NEITHER
// an age nor a sex recorded, so the profile header can hide
// the segment entirely instead of showing a placeholder
// (Jake, 2026-11-01). The Patient List's Age/Sex column was
// removed the same day; this helper now serves the profile
// header only.
function ageSexLabel(p: PersonUnderCare): string | null {
  const age =
    (p.dateOfBirth ? ageFromDob(p.dateOfBirth) : null) ?? p.age ?? null;
  const sexShort =
    p.sex === "Female" ? "F" : p.sex === "Male" ? "M" : (p.sex ?? null);
  if (age !== null && sexShort) return `${age}/${sexShort}`;
  if (age !== null) return `${age}`;
  if (sexShort) return sexShort;
  return p.ageBand !== "—" ? p.ageBand : null;
}

// Full address for the Patient List Address column, composed
// like the Profile's Contact address (street, line 2, city,
// state, ZIP) — without the country code the profile's
// directions text appends. "" when nothing is recorded.
function listAddressText(p: PersonUnderCare): string {
  return [
    p.street,
    p.streetLine2,
    [p.city, p.state]
      .map((part) => (part ?? "").trim())
      .filter(Boolean)
      .join(", "),
    p.postalCode,
  ]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

// Full name for a staff (clinician) card header: first + middle +
// last + suffix, skipping empty parts (Jake, 2026-10-30: the top
// of the clinician profile card shows the FULL name).
function staffFullName(m: ApiUser): string {
  return [m.fname, m.mname, m.lname, m.suffix]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

// Position line for a staff card (Jake, 2026-10-30): the staff
// POSITION leads when one is set. Otherwise the title leads IN
// PLACE OF the role label, and the role label is only the
// fallback when neither position nor title is set. Specialty
// follows. Position, title, and role are never shown together.
// Shared by the Clinician tab cards and the Contacts directory.
function staffPositionLine(m: ApiUser): string {
  const roleLabel =
    STAFF_ROLES.find((r) => r.value === m.role)?.label ?? m.role;
  return [m.position || m.title || roleLabel, m.specialty]
    .filter(Boolean)
    .join(" · ");
}

// Phone numbers for display: cell preferred, then phone; both
// when both exist (deduped). Shared by the Clinician tab cards
// and the Contacts directory.
function staffPhoneNumbers(m: ApiUser): string[] {
  return Array.from(
    new Set(
      [m.phonecell, m.phone].filter((n): n is string => Boolean(n)),
    ),
  );
}

// Clinical vs non-clinical grouping (Jake, 2026-10-30): the
// users table's `authorized` flag is CareTask's provider flag —
// authorized staff are the clinical group (they can be assigned
// patients); everyone else is non-clinical, whatever their role.
// One table, no extra field.
function staffGroups(staff: ApiUser[]): {
  heading: string;
  members: ApiUser[];
  empty: string;
}[] {
  return [
    {
      heading: "Clinical staff",
      members: staff.filter((m) => m.authorized),
      empty: "No clinical staff yet",
    },
    {
      heading: "Non-clinical staff",
      members: staff.filter((m) => !m.authorized),
      empty: "No non-clinical staff yet",
    },
  ];
}

// Full postal address as one line (", "-joined), for display and
// for the Google Maps directions link on the profile (Jake,
// 2026-10-30: tap/click the address -> map with directions).
function fullAddressText(p: PersonUnderCare): string {
  return [
    p.street,
    p.streetLine2,
    [p.city, p.state]
      .map((part) => (part ?? "").trim())
      .filter(Boolean)
      .join(", "),
    p.postalCode,
    p.countryCode,
  ]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

// Free Google Maps directions URL (no API key): destination is the
// stored coordinates when we have them, else the address text.
// Null when there is nothing to navigate to.
function mapsDirectionsUrl(p: PersonUnderCare): string | null {
  const dest =
    p.latitude != null && p.longitude != null
      ? `${p.latitude},${p.longitude}`
      : fullAddressText(p);
  return dest
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`
    : null;
}

function statusLabel(status: TrafficLight): string {
  return status === "green"
    ? "Green Zone"
    : status === "yellow"
      ? "Yellow Zone"
      : "Red Zone";
}

function initials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function decisionLabel(decision: FlagDecision): string {
  switch (decision) {
    case "acknowledged":
      return "Acknowledged by clinician";
    case "followup":
      return "Follow-up scheduled by clinician";
    case "dismissed":
      return "Dismissed by clinician";
    default:
      return "Awaiting clinician review";
  }
}

export default function Dashboard({
  user,
  theme,
  onToggleTheme,
  colorTheme,
  onColorThemeChange,
}: {
  user: User;
  theme: Theme;
  onToggleTheme: () => void;
  colorTheme: ColorTheme;
  onColorThemeChange: (next: ColorTheme) => void;
}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("dashboard");
  // One-shot intent for the calendar page: the sidebar
  // Appointment button sets "create" so CalendarView opens a
  // fresh booking form on arrival, then clears it (Jake,
  // 2026-11-02). The Calendar button passes no intent.
  const [calIntent, setCalIntent] = useState<"create" | null>(null);
  const [flags, setFlags] = useState<Flag[]>(initialFlags);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [forceDesktop, setForceDesktop] = useState(false);
  // The Patients sidebar group open/close state lived here
  // until 2026-11-01, when the submenu was removed entirely
  // and Patients became a direct sidebar button.
  const [query, setQuery] = useState("");
  // Mobile view (Jake, 2026-11-02): drawer state for the floating
  // menu button, the Patients status filter (funnel; defaults to
  // Active — search overrides it, see mobilePeople), its popover,
  // and whether Expenses was opened from the Mileage pill (which
  // auto-opens the current month's report).
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [patientStatusFilter, setPatientStatusFilter] = useState<
    "active" | "hold" | "discharged" | "all"
  >("active");
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [expensesAutoOpen, setExpensesAutoOpen] = useState(false);
  // Reports submenu (Jake, 2026-11-06): the sidebar Reports
  // button carries an Expenses submenu (Mileage Report +
  // Generate Concur Report). Expansion is automatic on the
  // Reports tab (or when Expenses was opened from the
  // submenu); clicking Reports while already there toggles it
  // via this override, which resets whenever the tab changes.
  const [reportsMenuToggled, setReportsMenuToggled] = useState<
    boolean | null
  >(null);
  const [expensesViaReports, setExpensesViaReports] = useState(false);
  // Bumped on every "Mileage Report" submenu click; ExpensesView
  // scrolls its Expense report card into view when it changes.
  const [focusReportNonce, setFocusReportNonce] = useState(0);
  const [concurBusy, setConcurBusy] = useState(false);
  // Minimal app toast (2026-11-06): used by the Generate
  // Concur Report action for now; auto-dismisses after ~6s.
  const [toast, setToast] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const listSearchRef = useRef<HTMLInputElement>(null);
  // Mobile profile swipe (2026-11-02): touch origin for the
  // profile card + the direction the current card slid in from.
  const profileTouchRef = useRef<{ x: number; y: number } | null>(null);
  const [swipeDir, setSwipeDir] = useState<"left" | "right" | null>(null);
  const [people, setPeople] = useState<PersonUnderCare[]>(peopleUnderCare);
  const [selectedId, setSelectedId] = useState(peopleUnderCare[0].id);
  // Where the patient list comes from: "local" (no API configured),
  // "connected" (list loaded from / saved to the patient API), or
  // "fallback" (API configured but unreachable — demo data kept).
  const [apiStatus, setApiStatus] = useState<
    "local" | "connected" | "fallback"
  >("local");
  // Unread message count for the Messages nav badge.
  const [unreadCount, setUnreadCount] = useState(0);
  // Dashboard overview cards (Jake, 2026-11-02): card one is a
  // live clock (ticking every 20s) with a weather icon; card two
  // counts today's appointments for its workload color band.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 20000);
    return () => clearInterval(t);
  }, []);
  const [weather, setWeather] = useState<WeatherNow | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => {
      void fetchWeather().then((w) => {
        if (live && w) setWeather(w);
      });
    };
    load();
    const t = setInterval(load, 30 * 60 * 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const [todayApptCount, setTodayApptCount] = useState<number | null>(
    null,
  );
  useEffect(() => {
    if (apiStatus !== "connected") {
      setTodayApptCount(daySchedule.length);
      return;
    }
    let live = true;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    listAppointments(user, start.toISOString(), end.toISOString())
      .then((list) => {
        if (live) {
          setTodayApptCount(
            list.filter(
              (a) =>
                a.cattype === "appointment" &&
                a.status !== "cancelled" &&
                a.status !== "no_show" &&
                a.status !== "missed",
            ).length,
          );
        }
      })
      .catch(() => {
        if (live) setTodayApptCount(null);
      });
    return () => {
      live = false;
    };
  }, [apiStatus, user, tab]);
  // Add Patient form (patients v2 fields). Grouped in the JSX as:
  // name / contact / demographics / care & consent / emergency
  // contact / billing. Required: first name + last name.
  const [formTitle, setFormTitle] = useState("");
  const [formFname, setFormFname] = useState("");
  const [formMname, setFormMname] = useState("");
  const [formLname, setFormLname] = useState("");
  const [formSuffix, setFormSuffix] = useState("");
  const [formPreferredName, setFormPreferredName] = useState("");
  const [formPhoneHome, setFormPhoneHome] = useState("");
  const [formPhoneCell, setFormPhoneCell] = useState("");
  const [formEmail, setFormEmail] = useState("");
  // Coordinates captured from an autocomplete pick (Add/Edit forms).
  // Typing an address by hand leaves these null — the patient is
  // then geocoded on map load instead (see lib/geo.ts).
  const [formLat, setFormLat] = useState<number | null>(null);
  const [formLng, setFormLng] = useState<number | null>(null);
  const [editLat, setEditLat] = useState<number | null>(null);
  const [editLng, setEditLng] = useState<number | null>(null);
  const [formStreet, setFormStreet] = useState("");
  const [formStreetLine2, setFormStreetLine2] = useState("");
  const [formCity, setFormCity] = useState("");
  const [formState, setFormState] = useState("");
  const [formPostalCode, setFormPostalCode] = useState("");
  const [formCountryCode, setFormCountryCode] = useState("US");
  const [formDob, setFormDob] = useState("");
  const [formAge, setFormAge] = useState("");
  const [formSex, setFormSex] = useState("");
  const [formRace, setFormRace] = useState("");
  const [formEthnicity, setFormEthnicity] = useState("");
  const [formLanguage, setFormLanguage] = useState("");
  const [formZone, setFormZone] = useState<TrafficLight>("green");
  const [formStatus, setFormStatus] = useState<PatientStatus>("active");
  const [formNote, setFormNote] = useState("");
  const [formClinician, setFormClinician] = useState("");
  const [formOccupation, setFormOccupation] = useState("");
  const [formReferrer, setFormReferrer] = useState("");


  const [formInterpreterNeeded, setFormInterpreterNeeded] = useState(false);
  const [formHipaaSms, setFormHipaaSms] = useState(false);
  const [formHipaaEmail, setFormHipaaEmail] = useState(false);
  const [formEmergencyName, setFormEmergencyName] = useState("");
  const [formEmergencyRelationship, setFormEmergencyRelationship] =
    useState("");
  const [formEmergencyPhone, setFormEmergencyPhone] = useState("");
  const [formBillingNote, setFormBillingNote] = useState("");
  const [formPricelevel, setFormPricelevel] = useState("standard");
  const [formFinancial, setFormFinancial] = useState("");
  const [formPharmacyId, setFormPharmacyId] = useState("");
  // Agency tag (schema-patients-agency.sql): directory id OR
  // free-text name, never both (AgencyPicker enforces it).
  const [formAgencyId, setFormAgencyId] = useState<number | null>(null);
  // Add Patient inline validation error (DOB / Sex required on
  // create — Jake, 2026-10-30).
  const [addFormError, setAddFormError] = useState<string | null>(null);
  const [formAgencyText, setFormAgencyText] = useState("");
  // Google Contacts import (prototype): picking a contact pre-fills
  // the Add Patient form below — nothing is saved by the import
  // itself. The duplicate check reacts to the filled names exactly
  // as if they were typed, and Save goes through the normal path.
  // (The Add form's Google Contacts import button was removed at
  // Jake's direction 2026-11-02; the picker still serves the
  // Clinician tab's staff import.)
  const [showTextIntake, setShowTextIntake] = useState(false);
  const [addedFields, setAddedFields] = useState<string[]>([]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  // Google-Contacts-style Add form: the rarely used fields are
  // added one at a time from the "Add field" dropdown — unless a
  // paste/contacts prefill put a value in one of them, in which
  // case its row is added automatically so the value is visible
  // instead of silently carried.
  useEffect(() => {
    const filled: Array<[string, string]> = [
      ["mname", formMname],
      ["phoneHome", formPhoneHome],
      ["street2", formStreetLine2],
      ["referrer", formReferrer],
    ];
    const missing = filled
      .filter(([k, v]) => v && !addedFields.includes(k))
      .map(([k]) => k);
    if (missing.length > 0) {
      setAddedFields((prev) => [...prev, ...missing]);
    }
  }, [formMname, formPhoneHome, formStreetLine2, formReferrer, addedFields]);

  function applyContactToPatientForm(c: ContactCandidate) {
    setFormFname(c.fname);
    setFormMname(c.mname);
    setFormLname(c.lname);
    setFormEmail(c.email);
    setFormPhoneHome(formatUSPhone(c.phoneHome));
    setFormPhoneCell(formatUSPhone(c.phoneCell));
    setFormStreet(c.street);
    setFormStreetLine2(c.streetLine2);
    setFormCity(c.city);
    setFormState(c.state);
    setFormPostalCode(c.postalCode);
    if (c.countryCode) setFormCountryCode(c.countryCode);
    setFormDob(c.dob);
    setFormSex(c.sex);
    setFormOccupation(c.occupation);
    if (c.note) setFormNote(c.note);
  }

  // Duplicate check for the Add Patient form: once a first AND last
  // name are entered, look for an existing patient with the same
  // name (the live database when connected, the on-screen list
  // otherwise) and warn before a second record is created. Warning
  // only — same-name different people exist, so saving stays allowed.
  interface DupMatch {
    id: string;
    name: string;
    dob: string | null;
    status: string;
    sameDob: boolean;
  }
  const [dupMatches, setDupMatches] = useState<DupMatch[]>([]);
  const [dupChecking, setDupChecking] = useState(false);

  // Server-side registry dedupe (platform, 2026-11-03): on Save
  // the API hard-blocks an exact match (409 PATIENT_EXISTS) and
  // prompts on near matches (409 POSSIBLE_MATCH). The form then
  // stays open with everything typed, and this panel offers the
  // way through: link the existing record, or confirm the create.
  interface DupCandidate {
    id: string;
    name: string;
    dob: string | null;
    city: string | null;
  }
  interface DupConflict {
    kind: "exists" | "possible";
    payload: NewApiPatient;
    patient?: DupCandidate & { already_linked: boolean };
    candidates?: DupCandidate[];
  }
  const [dupConflict, setDupConflict] = useState<DupConflict | null>(null);
  const [dupActionBusy, setDupActionBusy] = useState(false);
  useEffect(() => {
    const fname = formFname.trim().toLowerCase();
    const lname = formLname.trim().toLowerCase();
    if (!fname || !lname) {
      setDupMatches([]);
      setDupChecking(false);
      return;
    }
    let cancelled = false;
    setDupChecking(true);
    const t = setTimeout(async () => {
      try {
        let matches: DupMatch[] = [];
        if (apiStatus === "connected") {
          const rows = await searchPatients(user, formLname.trim());
          matches = rows
            .filter(
              (r) =>
                r.fname.trim().toLowerCase() === fname &&
                r.lname.trim().toLowerCase() === lname,
            )
            .map((r) => ({
              id: r.id,
              name: `${r.lname}, ${r.fname}`,
              dob: r.date_of_birth,
              status: r.status,
              sameDob: !!formDob && r.date_of_birth === formDob,
            }));
        } else {
          matches = people
            .filter(
              (p) =>
                (p.fname ?? "").trim().toLowerCase() === fname &&
                (p.lname ?? "").trim().toLowerCase() === lname,
            )
            .map((p) => ({
              id: p.id,
              name: `${p.lname ?? ""}, ${p.fname ?? ""}`,
              dob: p.dateOfBirth ?? null,
              status: p.patientStatus ?? "active",
              sameDob: !!formDob && p.dateOfBirth === formDob,
            }));
        }
        if (!cancelled) setDupMatches(matches);
      } catch {
        if (!cancelled) setDupMatches([]);
      } finally {
        if (!cancelled) setDupChecking(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [formFname, formLname, formDob, apiStatus, user, people]);

  // Patient Profile actions under the role model (the manager
  // PIN was retired on 2026-11-02): Edit is open to everyone —
  // patient updates are not gated. Delete is a manager/admin act
  // (the API role-gates the DELETE): managers get the Delete
  // button plus a confirm step. Clinicians manage their list by
  // STATUS instead — Put on hold / Discharge (and Return to
  // active) take the patient off the active list without
  // touching the record.
  const me = useMyStaff(user);
  const isManager = isManagerRole(me);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState("");
  // Mark-as-duplicate (patient merge round, 2026-11-02): the
  // profile's picker for the OTHER record of a suspected pair.
  const [dupPickerOpen, setDupPickerOpen] = useState(false);
  const [dupQuery, setDupQuery] = useState("");
  const [dupNote, setDupNote] = useState("");
  const [dupBusy, setDupBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [editFname, setEditFname] = useState("");
  const [editMname, setEditMname] = useState("");
  const [editLname, setEditLname] = useState("");
  const [editDob, setEditDob] = useState("");
  const [editAge, setEditAge] = useState("");
  const [editSex, setEditSex] = useState("");
  const [editPhoneHome, setEditPhoneHome] = useState("");
  const [editPhoneCell, setEditPhoneCell] = useState("");
  const [editStreet, setEditStreet] = useState("");
  const [editStreetLine2, setEditStreetLine2] = useState("");
  const [editCity, setEditCity] = useState("");
  const [editState, setEditState] = useState("");
  const [editPostalCode, setEditPostalCode] = useState("");
  const [editStatus, setEditStatus] = useState<PatientStatus>("active");
  const [editNote, setEditNote] = useState("");
  const [editAgencyId, setEditAgencyId] = useState<number | null>(null);
  const [editAgencyText, setEditAgencyText] = useState("");

  // Switching patients closes any open form or confirmation.
  useEffect(() => {
    setConfirmingDelete(false);
    setDeleteError("");
    setStatusError("");
    setEditing(false);
    setEditError("");
  }, [selectedId]);

  // Staff management on the Clinician tab, backed by the users
  // table (GET /users). Add / Edit / Deactivate / Reactivate are
  // role-gated (manager/admin) exactly like patient delete: the
  // API checks the caller's role server-side, and this tab only
  // offers the actions to managers. "Delete" is a deactivate —
  // the row and its history stay, and Reactivate undoes it. When
  // the API is unreachable the tab falls back to the derived
  // clinician list (staff stays null) — management is unavailable
  // either way.
  type StaffAction =
    | { kind: "add" }
    | { kind: "edit" | "deactivate" | "restore"; member: ApiUser }
    | { kind: "import"; candidates: ContactCandidate[] };
  const [staff, setStaff] = useState<ApiUser[] | null>(null);
  // Platform-scoped provider list for the calendar (colleagues);
  // null until loaded — the calendar falls back to the staff rows.
  const [colleagues, setColleagues] = useState<ApiUser[] | null>(null);
  const [staffNotice, setStaffNotice] = useState("");
  // Which staff card's "Patients" section is expanded (staff id),
  // or null when all are collapsed (Jake, 2026-10-30).
  const [patientsOpenFor, setPatientsOpenFor] = useState<string | null>(null);
  const [staffForm, setStaffForm] = useState<{ member: ApiUser | null } | null>(
    null,
  );
  const [sfFname, setSfFname] = useState("");
  const [sfMname, setSfMname] = useState("");
  const [sfLname, setSfLname] = useState("");
  const [sfSuffix, setSfSuffix] = useState("");
  const [sfPosition, setSfPosition] = useState("");
  const [sfEmail, setSfEmail] = useState("");
  const [sfRole, setSfRole] = useState<StaffRole>("clinician");
  const [sfAuthorized, setSfAuthorized] = useState(false);
  const [sfTitle, setSfTitle] = useState("");
  const [sfSpecialty, setSfSpecialty] = useState("");
  const [sfPhoneCell, setSfPhoneCell] = useState("");
  const [sfError, setSfError] = useState("");
  const [sfSaving, setSfSaving] = useState(false);
  const [confirmingDeactivate, setConfirmingDeactivate] =
    useState<ApiUser | null>(null);
  const [deactivateError, setDeactivateError] = useState("");

  // Load the staff directory for every tab that needs it: the
  // Clinician tab (management), Contacts (the same rows read-only),
  // and Appointment — the appointment form's Provider picker is fed
  // by these rows, and it rendered EMPTY when the calendar was
  // opened without visiting Clinician/Contacts first (Jake's
  // report, 2026-11-02; fixed in deploy-30 by loading here too).
  // Leaving the Clinician tab closes any open panel.
  useEffect(() => {
    const needsStaff =
      tab === "clinician" || tab === "contacts" || tab === "appointment";
    setStaffNotice("");
    setStaffForm(null);
    setConfirmingDeactivate(null);
    setDeactivateError("");
    if (!needsStaff) return;
    if (apiStatus !== "connected" || !user) {
      // Unreachable API → staff stays null and the page says the
      // directory is unavailable.
      setStaff(null);
      return;
    }
    let cancelled = false;
    listUsers(user)
      .then((rows) => {
        if (!cancelled) setStaff(rows);
      })
      .catch(() => {
        if (!cancelled) setStaff(null);
      });
    if (tab === "appointment") {
      // The booking form's Provider picker is platform-scoped
      // (2026-11-03): agency colleagues + me, from
      // GET /users/clinicians — not the whole staff directory.
      listClinicians(user)
        .then((rows) => {
          if (!cancelled) setColleagues(rows);
        })
        .catch(() => {
          if (!cancelled) setColleagues(null);
        });
    }
    if (tab === "clinician") {
      // Keep the Messages nav badge roughly current.
      listMessages(user, { unread: true })
        .then((out) => {
          if (!cancelled) setUnreadCount(out.messages.length);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [tab, apiStatus, user]);

  async function refreshStaff() {
    if (!user) return;
    try {
      setStaff(await listUsers(user));
    } catch {
      // Keep the on-screen list; the next tab visit reloads anyway.
    }
  }

  function requestStaffAction(action: StaffAction) {
    setStaffNotice("");
    setStaffForm(null);
    setConfirmingDeactivate(null);
    setDeactivateError("");
    proceedStaffAction(action);
  }

  function proceedStaffAction(action: StaffAction) {
    if (action.kind === "add") {
      openStaffForm(null);
    } else if (action.kind === "edit") {
      openStaffForm(action.member);
    } else if (action.kind === "deactivate") {
      setConfirmingDeactivate(action.member);
      setDeactivateError("");
    } else if (action.kind === "import") {
      void doImportStaff(action.candidates);
    } else {
      void doRestoreStaff(action.member);
    }
  }

  function openStaffForm(member: ApiUser | null) {
    setSfFname(member?.fname ?? "");
    setSfMname(member?.mname ?? "");
    setSfLname(member?.lname ?? "");
    setSfSuffix(member?.suffix ?? "");
    setSfPosition(member?.position ?? "");
    setSfEmail(member?.email ?? "");
    setSfRole(member?.role ?? "clinician");
    setSfAuthorized(member?.authorized ?? false);
    setSfTitle(member?.title ?? "");
    setSfSpecialty(member?.specialty ?? "");
    setSfPhoneCell(formatUSPhone(member?.phonecell ?? ""));
    setSfError("");
    setStaffForm({ member });
  }

  async function handleSaveStaff(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !staffForm) return;
    const input: StaffInput = {
      fname: sfFname.trim(),
      mname: sfMname.trim() || null,
      lname: sfLname.trim(),
      suffix: sfSuffix.trim() || null,
      position: sfPosition.trim() || null,
      email: sfEmail.trim().toLowerCase(),
      role: sfRole,
      authorized: sfAuthorized,
      title: sfTitle.trim() || null,
      specialty: sfSpecialty.trim() || null,
      phonecell: sfPhoneCell.trim() || null,
    };
    const member = staffForm.member;
    setSfSaving(true);
    setSfError("");
    try {
      if (member) {
        await updateStaff(user, member.id, input);
      } else {
        await createStaff(user, input);
      }
      setStaffForm(null);
      await refreshStaff();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (isRoleRejection(err)) {
        setSfError("Saving staff needs a manager or admin role.");
      } else if (code === "EMAIL_EXISTS") {
        setSfError("A staff member with that email already exists.");
      } else {
        setSfError("Couldn't save — check the connection and try again.");
      }
    } finally {
      setSfSaving(false);
    }
  }

  async function handleConfirmDeactivate() {
    if (!user || !confirmingDeactivate) return;
    const member = confirmingDeactivate;
    setDeactivateError("");
    try {
      await deactivateStaff(user, member.id);
      setConfirmingDeactivate(null);
      await refreshStaff();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (isRoleRejection(err)) {
        setDeactivateError(
          "Deactivating staff needs a manager or admin role.",
        );
      } else if (code === "SELF_DEACTIVATE") {
        setDeactivateError("You can't deactivate your own account.");
      } else {
        setDeactivateError(
          "Couldn't deactivate — check the connection and try again.",
        );
      }
    }
  }

  async function doRestoreStaff(member: ApiUser) {
    if (!user) return;
    setStaffNotice("");
    try {
      await restoreStaff(user, member.id);
      await refreshStaff();
    } catch (err) {
      if (isRoleRejection(err)) {
        setStaffNotice("Reactivating staff needs a manager or admin role.");
      } else {
        setStaffNotice(
          "Couldn't reactivate — check the connection and try again.",
        );
      }
    }
  }

  // Google Contacts staff import (prototype): create one users row
  // per picked contact, through the same role-gated create as the
  // form. Contacts without an email can't become staff (email is
  // the identity) and contacts whose email already exists are
  // skipped as duplicates — both are counted in the summary, never
  // silently dropped. Imported staff start as unauthorized
  // clinicians; a manager edits role/authorized afterwards.
  const [showStaffImport, setShowStaffImport] = useState(false);

  async function doImportStaff(candidates: ContactCandidate[]) {
    if (!user) return;
    setStaffNotice("");
    const existing = new Set(
      (staff ?? []).map((m) => m.email.toLowerCase()),
    );
    let created = 0;
    let duplicates = 0;
    let skipped = 0;
    let failed = 0;
    for (const c of candidates) {
      const email = c.email.trim().toLowerCase();
      if (!email) {
        skipped += 1;
        continue;
      }
      if (existing.has(email)) {
        duplicates += 1;
        continue;
      }
      const input: StaffInput = {
        fname: c.fname || "Unknown",
        lname: c.lname || c.fname || "Unknown",
        email,
        phonecell: c.phoneCell || c.phoneHome || null,
        organization: c.organization || null,
        title: c.orgTitle || null,
        specialty: c.occupation || null,
        role: "clinician",
        authorized: false,
      };
      try {
        await createStaff(user, input);
        existing.add(email);
        created += 1;
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (isRoleRejection(err)) {
          setStaffNotice(
            "Importing staff needs a manager or admin role — import stopped.",
          );
          return;
        }
        if (code === "EMAIL_EXISTS") duplicates += 1;
        else failed += 1;
      }
    }
    await refreshStaff();
    const parts = [`Imported ${created} staff`];
    if (duplicates) parts.push(`${duplicates} already on the team`);
    if (skipped) parts.push(`${skipped} skipped (no email)`);
    if (failed) parts.push(`${failed} failed`);
    setStaffNotice(parts.join(" · ") + ".");
  }

  function startEdit() {
    const p = selectedPerson;
    setEditFname(p.fname ?? "");
    setEditMname(p.mname ?? "");
    setEditLname(p.lname ?? "");
    setEditDob(p.dateOfBirth ?? "");
    setEditAge(p.age != null ? String(p.age) : "");
    setEditSex(p.sex ?? "");
    setEditPhoneHome(formatUSPhone(p.phoneHome ?? ""));
    setEditPhoneCell(formatUSPhone(p.phoneCell ?? ""));
    setEditStreet(p.street ?? "");
    setEditStreetLine2(p.streetLine2 ?? "");
    setEditCity(p.city ?? "");
    setEditState(p.state ?? "");
    setEditPostalCode(p.postalCode ?? "");
    setEditLat(p.latitude ?? null);
    setEditLng(p.longitude ?? null);
    setEditStatus(
      p.patientStatus === "hold" || p.patientStatus === "discharged"
        ? p.patientStatus
        : "active",
    );
    setEditNote(p.statusNote === "—" ? "" : p.statusNote);
    setEditAgencyId(p.agencyId ?? null);
    setEditAgencyText(p.agencyNameText ?? "");
    setEditError("");
    setEditing(true);
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    const blankToNull = (s: string): string | null => {
      const t = s.trim();
      return t ? t : null;
    };
    const editAgeParsed =
      editAge.trim() === "" ? null : Number.parseInt(editAge, 10);
    const payload = {
      fname: editFname.trim(),
      mname: blankToNull(editMname),
      lname: editLname.trim(),
      date_of_birth: blankToNull(editDob),
      age: Number.isNaN(editAgeParsed) ? null : editAgeParsed,
      sex: blankToNull(editSex),
      phone_home: blankToNull(editPhoneHome),
      phone_cell: blankToNull(editPhoneCell),
      street: blankToNull(editStreet),
      street_line_2: blankToNull(editStreetLine2),
      city: blankToNull(editCity),
      state: blankToNull(editState),
      postal_code: blankToNull(editPostalCode),
      latitude: editLat,
      longitude: editLng,
      status: editStatus,
      notes: editNote.trim(),
      // Always send both agency fields so the stored tag is
      // exactly one mode (directory id XOR free text XOR none).
      agency_id: editAgencyId,
      agency_name_text:
        editAgencyId !== null ? null : blankToNull(editAgencyText),
    };
    if (!payload.fname || !payload.lname) {
      setEditError("First and last name are required.");
      return;
    }
    setEditSaving(true);
    setEditError("");
    try {
      if (apiStatus === "connected") {
        const updated = await updatePatient(
          user,
          selectedPerson.id,
          payload,
        );
        setPeople((prev) =>
          prev.map((p) => (p.id === updated.id ? updated : p)),
        );
      } else {
        setPeople((prev) =>
          prev.map((p) => {
            if (p.id !== selectedPerson.id) return p;
            const full = [payload.fname, payload.mname, payload.lname]
              .filter(Boolean)
              .join(" ");
            return {
              ...p,
              name: p.preferredName?.trim() ? p.preferredName : full,
              fname: payload.fname,
              mname: payload.mname,
              lname: payload.lname,
              dateOfBirth: payload.date_of_birth,
              age: payload.age,
              ageBand: ageBandFromDob(payload.date_of_birth),
              sex: payload.sex,
              phoneHome: payload.phone_home,
              phoneCell: payload.phone_cell,
              street: payload.street,
              streetLine2: payload.street_line_2,
              city: payload.city,
              state: payload.state,
              postalCode: payload.postal_code,
              latitude: payload.latitude,
              longitude: payload.longitude,
              patientStatus: payload.status,
              statusNote: payload.notes || "—",
              agencyId: payload.agency_id,
              agencyNameText: payload.agency_name_text,
              agencyName:
                payload.agency_id !== null
                  ? (p.agencyId === payload.agency_id ? p.agencyName : null)
                  : payload.agency_name_text,
            };
          }),
        );
      }
      setEditing(false);
    } catch {
      setEditError(
        "Save failed — the change was not applied. Check the connection and try again.",
      );
    } finally {
      setEditSaving(false);
    }
  }

  async function handleConfirmDelete() {
    const id = selectedPerson.id;
    setDeleteError("");
    try {
      if (apiStatus === "connected") {
        await deletePatient(user, id);
      }
    } catch (err) {
      setDeleteError(
        isRoleRejection(err)
          ? "Deleting a patient needs a manager or admin role."
          : "Delete failed — the record was not removed. Check the connection and try again.",
      );
      return;
    }
    const remaining = people.filter((p) => p.id !== id);
    setPeople(remaining);
    setConfirmingDelete(false);
    setSelectedId(remaining[0]?.id ?? "");
    setTab("list");
  }

  // Patient merge (2026-11-02): mark this record as a suspected
  // duplicate of another. The review + merge itself lives on the
  // Patients tab (MergeReview). Connected mode only — demo data
  // has no server to mark against.
  async function handleMarkDuplicate(otherId: string, otherName: string) {
    setDupBusy(true);
    try {
      await markDuplicatePair(user, selectedPerson.id, otherId);
      setDupPickerOpen(false);
      setDupQuery("");
      setDupNote(
        `Marked as a possible duplicate of ${otherName}. Review the pair from the Patients list.`,
      );
    } catch {
      setDupNote(
        "That mark didn't save — check the connection and try again.",
      );
    } finally {
      setDupBusy(false);
    }
  }

  // After a merge (or an undo), reload the patient list and keep
  // the selection on a live record: if the selected patient was
  // the one retired, follow to the kept record.
  async function handleMerged(survivorId: string, loserId: string) {
    try {
      const loaded = await listPatients(user);
      setPeople(loaded);
      if (selectedId === loserId) setSelectedId(survivorId);
    } catch {
      // The merge itself succeeded; a stale list refreshes on the
      // next load.
    }
  }

  function openPatientById(id: string) {
    setSwipeDir(null);
    setSelectedId(id);
    setTab("profile");
  }

  // Swipe/button navigation between profiles, following the
  // Patients list's visible order (mobilePeople — sorted, with
  // the status filter/search applied). No wrap at the ends; a
  // profile outside the current filter doesn't swipe.
  function swipeProfile(dir: "next" | "prev") {
    if (editing || confirmingDelete) return;
    const idx = mobilePeople.findIndex((p) => p.id === selectedId);
    if (idx < 0) return;
    const target = mobilePeople[dir === "next" ? idx + 1 : idx - 1];
    if (!target) return;
    setSwipeDir(dir === "next" ? "left" : "right");
    setDupPickerOpen(false);
    setDupNote("");
    setStatusError("");
    setConfirmingUnlink(false);
    setUnlinkError("");
    setSelectedId(target.id);
  }

  // Clinician list management: move a patient off (or back onto)
  // MY list by STATUS — no delete, no gate. Platform (2026-11-03):
  // list status lives on the caller's patient_link, not the shared
  // registry record, so my "discharged" never touches a colleague's
  // list. Connected mode writes the link; demo mode updates local
  // state.
  async function handleSetPatientStatus(status: PatientStatus) {
    const id = selectedPerson.id;
    setStatusSaving(true);
    setStatusError("");
    try {
      if (apiStatus === "connected") {
        await setLinkStatus(user, id, status);
        setPeople((prev) =>
          prev.map((p) => (p.id === id ? { ...p, patientStatus: status } : p)),
        );
      } else {
        setPeople((prev) =>
          prev.map((p) =>
            p.id === id ? { ...p, patientStatus: status } : p,
          ),
        );
      }
    } catch {
      setStatusError(
        "Couldn't change the status — check the connection and try again.",
      );
    } finally {
      setStatusSaving(false);
    }
  }

  // Remove the patient from MY list entirely (platform): the
  // registry record, its episodes, and its history stay — I just
  // stop seeing it (unless an episode team or a coverage visit
  // still connects me). Two-step confirm, like Delete.
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const [unlinkError, setUnlinkError] = useState("");
  async function handleRemoveFromList() {
    const id = selectedPerson.id;
    setUnlinkError("");
    try {
      await unlinkPatient(user, id);
      setPeople((prev) => prev.filter((p) => p.id !== id));
      setConfirmingUnlink(false);
      setTab("list");
    } catch {
      setUnlinkError(
        "Couldn't remove this patient from your list — try again.",
      );
    }
  }
  // Audit Log view state. Filters persist while the dashboard is
  // open; the list reloads when the view opens, when filters are
  // applied, and when paging.
  const [auditEvents, setAuditEvents] = useState<ApiEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState("");
  const [auditFilterEvent, setAuditFilterEvent] = useState<
    "" | AuditEventName
  >("");
  const [auditFilterUser, setAuditFilterUser] = useState("");
  const [auditFilterPatient, setAuditFilterPatient] = useState("");
  const [auditFilterFrom, setAuditFilterFrom] = useState("");
  const [auditFilterTo, setAuditFilterTo] = useState("");
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditChain, setAuditChain] = useState<Record<
    string,
    ChainVerification
  > | null>(null);
  // Log page search + sort (Jake, 2026-10-30): search filters the
  // loaded page of events in the browser; column headers sort it.
  // The server filters above stay exactly as they were — this is
  // additive, on top of the rows they return.
  const auditSearchRef = useRef<HTMLInputElement>(null);
  const [auditSearch, setAuditSearch] = useState("");
  type AuditSortKey = "event" | "actor" | "time" | "type" | "patient" | "ip";
  const [auditSort, setAuditSort] = useState<{
    key: AuditSortKey;
    dir: 1 | -1;
  } | null>(null);
  function toggleAuditSort(key: AuditSortKey) {
    setAuditSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === 1 ? -1 : 1 }
        : { key, dir: 1 },
    );
  }
  function auditPatientName(e: ApiEvent): string {
    return e.patient_id
      ? (people.find((p) => p.id === e.patient_id)?.name ?? e.patient_id)
      : "";
  }
  const auditQuery = auditSearch.trim().toLowerCase();
  const visibleAuditEvents = [...auditEvents]
    .filter((e) => {
      if (!auditQuery) return true;
      const haystack = [
        describeEvent(e, people),
        e.actor_email,
        e.event,
        auditPatientName(e),
        e.ip ?? "",
        new Date(e.created_at).toLocaleString(),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(auditQuery);
    })
    .sort((a, b) => {
      if (!auditSort) return 0;
      const value = (e: ApiEvent): string => {
        switch (auditSort.key) {
          case "event":
            return describeEvent(e, people).toLowerCase();
          case "actor":
            return e.actor_email.toLowerCase();
          case "time":
            return e.created_at;
          case "type":
            return e.event;
          case "patient":
            return auditPatientName(e).toLowerCase();
          case "ip":
            return e.ip ?? "";
        }
      };
      const av = value(a);
      const bv = value(b);
      return (av < bv ? -1 : av > bv ? 1 : 0) * auditSort.dir;
    });
  // Export the Log table exactly as shown (search + sort applied)
  // as a CSV download, generated on-device. The export itself is
  // reported as a report_export event, same as other exports.
  function exportAuditCsv() {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = visibleAuditEvents.map((e) =>
      [
        describeEvent(e, people),
        e.actor_email,
        new Date(e.created_at).toLocaleString(),
        e.event,
        auditPatientName(e),
        e.ip ?? "",
      ]
        .map(esc)
        .join(","),
    );
    const csv = [
      ["Event", "Actor", "Time", "Type", "Patient", "IP"]
        .map(esc)
        .join(","),
      ...rows,
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "caretask-log.csv";
    a.click();
    URL.revokeObjectURL(url);
    reportEvent(user, "report_export").catch(() => {});
  }

  // On sign-in, the patient API is the primary source: a successful
  // list response replaces the in-browser demo data, even if it is
  // empty (an empty database is an honest empty state, not a reason to
  // silently show demo rows). Only a failed request falls back to the
  // in-browser demo data, and that state gets a visible banner.
  useEffect(() => {
    // Best-effort: record the sign-in in the audit log. A logging
    // failure is swallowed — it must never break sign-in. (A page
    // reload restores the session and reports a fresh sign-in; that
    // duplicate is harmless history noise, not corruption.)
    reportEvent(user, "sign_in").catch(() => {});
    if (!isApiConfigured()) {
      setApiStatus("local");
      return;
    }
    let cancelled = false;
    // One retry before the fallback verdict (Jake, 2026-11-02):
    // a single failed check used to brand the whole session
    // "API unreachable" even when the API was fine a second
    // later (a slow connection, a token still refreshing, a
    // stray tab's stale session). Two failures in a row, ~1.5s
    // apart, is a much more honest signal.
    (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const loaded = await listPatients(user);
          if (cancelled) return;
          setPeople(loaded);
          setSelectedId(loaded[0]?.id ?? "");
          setApiStatus("connected");
          return;
        } catch {
          if (cancelled) return;
          if (attempt === 0)
            await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (!cancelled) setApiStatus("fallback");
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // When a profile is opened and the API is connected, refresh that one
  // patient from the API (GET /patients/:id). Errors are ignored on
  // purpose: the list data is already showing, and a failed refresh
  // must not flip the whole list back to demo data.
  useEffect(() => {
    if (tab !== "profile" || apiStatus !== "connected") return;
    let cancelled = false;
    getPatient(user, selectedId)
      .then((person) => {
        if (cancelled) return;
        setPeople((prev) =>
          prev.map((p) => (p.id === person.id ? person : p)),
        );
      })
      .catch(() => {
        // Keep the list data already on screen.
      });
    return () => {
      cancelled = true;
    };
  }, [tab, selectedId, apiStatus, user]);

  async function handleSignOut() {
    // Best-effort: record the sign-out BEFORE signing out, because
    // the call needs the user's token. Failures are swallowed —
    // sign-out proceeds regardless.
    if (isApiConfigured()) {
      try {
        await reportEvent(user, "sign_out");
      } catch {
        // Sign-out proceeds regardless.
      }
    }
    if (auth) await signOut(auth);
    navigate("/login", { replace: true });
  }

  // Load one page of audit events plus the chain verification. Used
  // when the Audit Log view opens, when filters are applied, and
  // when paging. Failures surface as an error note, never a crash.
  async function loadAudit(offset: number) {
    if (!isApiConfigured()) return;
    setAuditLoading(true);
    setAuditError("");
    try {
      const [events, chain] = await Promise.all([
        listEvents(user, {
          event: auditFilterEvent || undefined,
          actor_email: auditFilterUser.trim() || undefined,
          patient_id: auditFilterPatient || undefined,
          from: auditFilterFrom || undefined,
          to: auditFilterTo || undefined,
          limit: AUDIT_PAGE_SIZE,
          offset,
        }),
        verifyChain(user),
      ]);
      setAuditEvents(events);
      setAuditChain(chain);
      setAuditOffset(offset);
    } catch {
      setAuditError("Could not load the audit log from the patient API.");
    } finally {
      setAuditLoading(false);
    }
  }

  // When the Audit Log view opens and the API is usable, load the
  // first page with the current filters.
  useEffect(() => {
    if (tab !== "audit" || !isApiConfigured() || apiStatus === "fallback") {
      return;
    }
    void loadAudit(0);
    // Filters are read at open time; applying new filters uses the
    // form submit below, not this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, apiStatus]);

  function decideFlag(id: string, decision: FlagDecision) {
    setFlags((prev) =>
      prev.map((f) => (f.id === id ? { ...f, decision } : f)),
    );
  }

  async function handleAddPatient(e: React.FormEvent) {
    e.preventDefault();
    // Date of birth and Sex were required when ADDING a patient
    // from 2026-10-30 to 2026-11-01. Jake made both OPTIONAL on
    // 2026-11-01 (the Age field covers patients whose birth date
    // is unknown, and CSV imports must not block on a missing
    // birthday/gender) — no validation for them here or in the
    // API anymore.
    setAddFormError(null);
    setDupConflict(null);
    const blankToNull = (s: string): string | null => {
      const t = s.trim();
      return t ? t : null;
    };
    const fname = formFname.trim();
    const lname = formLname.trim();
    const preferredName = blankToNull(formPreferredName);
    const fullName = [
      formTitle.trim(),
      fname,
      formMname.trim(),
      lname,
      formSuffix.trim(),
    ]
      .filter(Boolean)
      .join(" ");
    const displayName = preferredName ?? fullName;
    const statusNote = formNote.trim() || "Added in this demo";
    const clinician = formClinician.trim() || "Unassigned";
    const pharmacyId =
      formPharmacyId.trim() === ""
        ? null
        : Number.parseInt(formPharmacyId, 10);
    const formAgeParsed =
      formAge.trim() === "" ? null : Number.parseInt(formAge, 10);
    const ageYears = Number.isNaN(formAgeParsed) ? null : formAgeParsed;
    // When the API is configured, save there first so the patient
    // persists. Any failure falls back to the old session-only add —
    // the dashboard never loses the patient the clinician just typed.
    const localPerson: PersonUnderCare = {
      id: `local-${Date.now()}`,
      name: displayName,
      ageBand: ageBandFromDob(blankToNull(formDob)),
      status: formZone,
      statusNote,
      lastCheckIn: "—",
      nextReview: "—",
      clinician,
      title: blankToNull(formTitle),
      fname,
      mname: blankToNull(formMname),
      lname,
      suffix: blankToNull(formSuffix),
      preferredName,
      dateOfBirth: blankToNull(formDob),
      age: ageYears,
      sex: blankToNull(formSex),
      race: blankToNull(formRace),
      ethnicity: blankToNull(formEthnicity),
      language: blankToNull(formLanguage),
      street: blankToNull(formStreet),
      streetLine2: blankToNull(formStreetLine2),
      city: blankToNull(formCity),
      state: blankToNull(formState),
      postalCode: blankToNull(formPostalCode),
      countryCode: blankToNull(formCountryCode),
      latitude: formLat,
      longitude: formLng,
      phoneHome: blankToNull(formPhoneHome),
      phoneCell: blankToNull(formPhoneCell),
      email: blankToNull(formEmail),
      occupation: blankToNull(formOccupation),
      interpreterNeeded: formInterpreterNeeded,
      hipaaAllowsSms: formHipaaSms,
      hipaaAllowsEmail: formHipaaEmail,
      referrer: blankToNull(formReferrer),
      patientStatus: formStatus,
      emergencyContactName: blankToNull(formEmergencyName),
      emergencyContactRelationship: blankToNull(formEmergencyRelationship),
      emergencyContactPhone: blankToNull(formEmergencyPhone),
      billingNote: blankToNull(formBillingNote),
      pricelevel: formPricelevel.trim() || "standard",
      financial: blankToNull(formFinancial),
      pharmacyId:
        pharmacyId !== null && Number.isNaN(pharmacyId) ? null : pharmacyId,
      agencyId: formAgencyId,
      agencyNameText:
        formAgencyId !== null ? null : blankToNull(formAgencyText),
      agencyName:
        formAgencyId !== null ? null : blankToNull(formAgencyText),
    };
    if (isApiConfigured()) {
      const payload: NewApiPatient = {
          title: blankToNull(formTitle),
          fname,
          mname: blankToNull(formMname),
          lname,
          suffix: blankToNull(formSuffix),
          preferred_name: preferredName,
          date_of_birth: blankToNull(formDob),
          age: ageYears,
          sex: blankToNull(formSex),
          race: blankToNull(formRace),
          ethnicity: blankToNull(formEthnicity),
          language: blankToNull(formLanguage),
          street: blankToNull(formStreet),
          street_line_2: blankToNull(formStreetLine2),
          city: blankToNull(formCity),
          state: blankToNull(formState),
          postal_code: blankToNull(formPostalCode),
          country_code: blankToNull(formCountryCode),
          latitude: formLat,
          longitude: formLng,
          phone_home: blankToNull(formPhoneHome),
          phone_cell: blankToNull(formPhoneCell),
          email: blankToNull(formEmail),
          zone: formZone,
          notes: statusNote,
          clinician,
          occupation: blankToNull(formOccupation),
          interpreter_needed: formInterpreterNeeded,
          hipaa_allowsms: formHipaaSms,
          hipaa_allowemail: formHipaaEmail,
          referrer: blankToNull(formReferrer),
          status: formStatus,
          emergency_contact_name: blankToNull(formEmergencyName),
          emergency_contact_relationship: blankToNull(
            formEmergencyRelationship,
          ),
          emergency_contact_phone: blankToNull(formEmergencyPhone),
          billing_note: blankToNull(formBillingNote),
          pricelevel: formPricelevel.trim() || "standard",
          financial: blankToNull(formFinancial),
          pharmacy_id: localPerson.pharmacyId,
          agency_id: formAgencyId,
          agency_name_text:
            formAgencyId !== null ? null : blankToNull(formAgencyText),
      };
      try {
        const person = await createPatient(user, payload);
        setPeople((prev) => [...prev, person]);
        setSelectedId(person.id);
        setApiStatus("connected");
      } catch (err) {
        // Platform dedupe: an exact registry match is a hard
        // block and a near match needs a decision — either way the
        // form STAYS OPEN with everything typed, and the conflict
        // panel (under the name fields) offers the way through.
        // Only other failures take the session-only fallback.
        const apiErr = err as ApiRequestError | null;
        const body = apiErr?.body as {
          patient?: DupConflict["patient"];
          candidates?: DupCandidate[];
        } | null;
        if (apiErr?.code === "PATIENT_EXISTS" && body?.patient) {
          setDupConflict({ kind: "exists", payload, patient: body.patient });
          return;
        }
        if (apiErr?.code === "POSSIBLE_MATCH" && body?.candidates) {
          setDupConflict({
            kind: "possible",
            payload,
            candidates: body.candidates,
          });
          return;
        }
        setPeople((prev) => [...prev, localPerson]);
        setSelectedId(localPerson.id);
        setApiStatus("fallback");
      }
    } else {
      setPeople((prev) => [...prev, localPerson]);
      setSelectedId(localPerson.id);
    }
    resetAddForm();
    setTab("profile");
  }

  // Duplicate-conflict resolution: link the registry record the
  // API found instead of creating a second one. The patient opens
  // on their profile, exactly as if they'd just been added.
  async function handleLinkExisting(patientId: string) {
    setDupActionBusy(true);
    setAddFormError(null);
    try {
      await linkPatient(user, patientId);
      const person = await getPatient(user, patientId);
      setPeople((prev) =>
        prev.some((p) => p.id === person.id)
          ? prev.map((p) => (p.id === person.id ? person : p))
          : [...prev, person],
      );
      setSelectedId(person.id);
      setDupConflict(null);
      resetAddForm();
      setTab("profile");
    } catch {
      setAddFormError(
        "Couldn't add that patient to your list — check the connection and try again.",
      );
    } finally {
      setDupActionBusy(false);
    }
  }

  // Duplicate-conflict resolution: the user reviewed the possible
  // matches and says this is a different person. confirm_create
  // is recorded server-side as a known non-duplicate.
  async function handleCreateAnyway() {
    if (!dupConflict) return;
    setDupActionBusy(true);
    setAddFormError(null);
    try {
      const person = await createPatient(user, {
        ...dupConflict.payload,
        confirm_create: true,
      });
      setPeople((prev) => [...prev, person]);
      setSelectedId(person.id);
      setApiStatus("connected");
      setDupConflict(null);
      resetAddForm();
      setTab("profile");
    } catch {
      setAddFormError("Couldn't save the patient — try again.");
    } finally {
      setDupActionBusy(false);
    }
  }

  function resetAddForm() {
    setDupConflict(null);
    setFormTitle("");
    setFormFname("");
    setFormMname("");
    setFormLname("");
    setFormSuffix("");
    setFormPreferredName("");
    setFormPhoneHome("");
    setFormPhoneCell("");
    setFormEmail("");
    setFormStreet("");
    setFormStreetLine2("");
    setFormCity("");
    setFormState("");
    setFormPostalCode("");
    setFormLat(null);
    setFormLng(null);
    setFormCountryCode("US");
    setFormDob("");
    setFormAge("");
    setFormSex("");
    setFormRace("");
    setFormEthnicity("");
    setFormLanguage("");
    setFormZone("green");
    setFormStatus("active");
    setFormNote("");
    setFormClinician("");
    setFormOccupation("");
    setFormReferrer("");
    setFormInterpreterNeeded(false);
    setFormHipaaSms(false);
    setFormHipaaEmail(false);
    setFormEmergencyName("");
    setFormEmergencyRelationship("");
    setFormEmergencyPhone("");
    setFormBillingNote("");
    setFormPricelevel("standard");
    setFormFinancial("");
    setFormPharmacyId("");
    setFormAgencyId(null);
    setFormAgencyText("");
  }

  const sortedTickets = [...triageTickets].sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  );

  const maxBar = Math.max(...analytics.weeklyFlagsReviewed);
  const openFlags = flags.filter((f) => f.decision === "open");
  // Card two's workload band (Jake, 2026-11-02 — his ranges
  // overlapped at the edges; resolved as 1–3 green, 4 yellow,
  // 5–7 red, 8+ deep red, 0 = plain card).
  const apptBand =
    todayApptCount === null || todayApptCount === 0
      ? "band-none"
      : todayApptCount <= 3
        ? "band-green"
        : todayApptCount === 4
          ? "band-yellow"
          : todayApptCount <= 7
            ? "band-red"
            : "band-deepred";
  const weatherIcon = !weather ? (
    <CloudSun size={40} aria-hidden="true" />
  ) : weather.group === "clear" ? (
    weather.isDay ? (
      <Sun size={40} aria-hidden="true" />
    ) : (
      <Moon size={40} aria-hidden="true" />
    )
  ) : weather.group === "partly" ? (
    weather.isDay ? (
      <CloudSun size={40} aria-hidden="true" />
    ) : (
      <CloudMoon size={40} aria-hidden="true" />
    )
  ) : weather.group === "rain" || weather.group === "drizzle" ? (
    <CloudRain size={40} aria-hidden="true" />
  ) : weather.group === "snow" ? (
    <CloudSnow size={40} aria-hidden="true" />
  ) : weather.group === "thunder" ? (
    <CloudLightning size={40} aria-hidden="true" />
  ) : (
    <Cloud size={40} aria-hidden="true" />
  );

  const q = query.trim().toLowerCase();
  const visiblePeople = q
    ? people.filter((p) => p.name.toLowerCase().includes(q))
    : people;

  // Patients table sorting (Jake, 2026-10-30): click a column
  // header to sort by it; click again to reverse. Default: last
  // name, A-Z. Columns are Patient | Address — the Zone, Status
  // and Clinician columns were removed at Jake's direction (the
  // zone dot before the name stays), and the Age/Sex column was
  // removed 2026-11-01 (also Jake). Address sorts by street,
  // then city.
  const [listSort, setListSort] = useState<{
    key: "name" | "address";
    dir: 1 | -1;
  }>({ key: "name", dir: 1 });
  function toggleListSort(key: "name" | "address") {
    setListSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 1 ? -1 : 1 }
        : { key, dir: 1 },
    );
  }
  const sortedPeople = [...visiblePeople].sort((a, b) => {
    if (listSort.key === "address") {
      const av = `${a.street ?? ""} ${a.city ?? ""}`.toLowerCase();
      const bv = `${b.street ?? ""} ${b.city ?? ""}`.toLowerCase();
      return av < bv ? -listSort.dir : av > bv ? listSort.dir : 0;
    }
    const av = listName(a).toLowerCase();
    const bv = listName(b).toLowerCase();
    return av < bv ? -listSort.dir : av > bv ? listSort.dir : 0;
  });

  // Mobile Patients cards (Jake, 2026-11-02): the funnel status
  // filter applies ONLY while not searching — a name search
  // searches all patients (every status) and overrides the filter.
  const searching = q.length > 0;
  const mobilePeople = searching
    ? sortedPeople
    : sortedPeople.filter(
        (p) =>
          patientStatusFilter === "all" ||
          (p.patientStatus ?? "active") === patientStatusFilter,
      );

  const selectedPerson =
    people.find((p) => p.id === selectedId) ??
    people[0] ?? {
      // Empty-database placeholder: keeps the profile tab rendering an
      // honest empty state instead of crashing on people[0] of [].
      id: "",
      name: "No patients in the demo database",
      ageBand: "—",
      status: "green" as TrafficLight,
      statusNote: "The API returned an empty patient list.",
      lastCheckIn: "—",
      nextReview: "—",
      clinician: "Unassigned",
    };
  // Compact age/sex for the profile header (Jake, 2026-10-30):
  // "74/F" — exact age from DOB, sex as F/M, stored-age
  // fallback when there is no DOB (2026-11-01). Null when the
  // patient has neither — the header's filter(Boolean) then
  // drops the segment entirely (Jake, 2026-11-01).
  const selectedAgeSex = ageSexLabel(selectedPerson);
  const selectedDay = daySchedule.filter(
    (e) => e.person === selectedPerson.name,
  );
  const selectedReminders = reminders.filter(
    (r) => r.person === selectedPerson.name,
  );

  const clinicians = [...new Set(people.map((p) => p.clinician))].map(
    (name) => {
      const patients = people.filter((p) => p.clinician === name);
      return {
        name,
        patients,
        green: patients.filter((p) => p.status === "green").length,
        yellow: patients.filter((p) => p.status === "yellow").length,
        red: patients.filter((p) => p.status === "red").length,
      };
    },
  );

  const patientActive =
    tab === "list" || tab === "profile" || tab === "add" || tab === "map";

  // Mobile docked-bar title (standard mobile header, Jake,
  // 2026-11-02): the shell bar names the current view; on the
  // patient profile it names the patient.
  const TAB_TITLES: Partial<Record<Tab, string>> = {
    dashboard: "Dashboard",
    list: "Patients",
    add: "Add Patient",
    map: "Patients Map",
    appointment: "Calendar",
    expenses: "Expenses",
    audit: "Audit Log",
    help: "Help Center",
    categories: "Visit Categories",
  };
  const mobileTitle =
    tab === "profile"
      ? "Patient Profile"
      : (TAB_TITLES[tab] ?? tab.charAt(0).toUpperCase() + tab.slice(1));

  // The Reports submenu toggle override lasts only while the
  // user stays on the tab they toggled it from.
  useEffect(() => {
    setReportsMenuToggled(null);
  }, [tab]);

  // Clear any pending toast auto-dismiss on unmount.
  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // Reports submenu expansion: automatic on the Reports tab or
  // when Expenses was opened from the submenu; the toggle
  // override applies until the next tab change.
  const reportsExpanded =
    reportsMenuToggled ??
    (tab === "reports" || (tab === "expenses" && expensesViaReports));

  const showToast = (kind: "success" | "error", text: string) => {
    setToast({ kind, text });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 6000);
  };

  const openMileageReport = () => {
    setExpensesViaReports(true);
    setExpensesAutoOpen(false);
    setFocusReportNonce((n) => n + 1);
    setTab("expenses");
  };

  // Reports submenu → Generate Concur Report (Jake, 2026-11-06):
  // the one-click shortcut — current calendar month, all
  // agencies, CSV downloads immediately. Custom period/agency
  // exports stay on the Reports view's ConcurExportCard.
  const generateConcurReport = async () => {
    if (concurBusy) return;
    if (apiStatus !== "connected") {
      showToast("error", "Not connected to the API.");
      return;
    }
    setConcurBusy(true);
    try {
      const now = new Date();
      const y = now.getFullYear();
      const m = `${now.getMonth() + 1}`.padStart(2, "0");
      const last = `${new Date(y, now.getMonth() + 1, 0).getDate()}`.padStart(
        2,
        "0",
      );
      const rep = await fetchMileageReport(user, {
        from: `${y}-${m}-01`,
        to: `${y}-${m}-${last}`,
        agency_id: null,
      });
      const fallbackRate =
        parseFloat(localStorage.getItem("caretask-mileage-rate") ?? "0.70") ||
        0.70;
      const stats = downloadConcurCsv(rep, fallbackRate);
      showToast(
        "success",
        `Concur CSV downloaded — ${stats.entries} mileage ${stats.entries === 1 ? "entry" : "entries"}, ` +
          `${Math.round(stats.miles * 100) / 100} mi` +
          (stats.expense_count
            ? `, plus ${stats.expense_count} expense ${stats.expense_count === 1 ? "line" : "lines"}`
            : "") +
          `, $${(stats.cents / 100).toFixed(2)} total. Personal (commute) legs are excluded.`,
      );
    } catch (err) {
      showToast(
        "error",
        err instanceof Error && err.message
          ? err.message
          : "Could not generate the Concur report.",
      );
    } finally {
      setConcurBusy(false);
    }
  };

  return (
    <div
      className={
        (forceDesktop ? "app-shell force-desktop" : "app-shell") +
        (mobileMenuOpen ? " menu-open" : "")
      }
    >
      <header className="app-header">
        <div className="header-left">
          <Mark size={40} />
          <p className="brand-name">MARC INNOTECH</p>
        </div>
        <div className="header-right">
          <span className="signed-in-as">{user.email}</span>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={onToggleTheme}
            title={
              theme === "light"
                ? "Switch to dark mode"
                : "Switch to light mode"
            }
          >
            {theme === "light" ? (<><Moon size={16} /> Dark</>) : (<><Sun size={16} /> Light</>)}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => setForceDesktop(!forceDesktop)}
            title={
              forceDesktop
                ? "Switch back to the mobile layout"
                : "Show the desktop layout"
            }
            aria-label={
              forceDesktop
                ? "Switch back to the mobile layout"
                : "Show the desktop layout"
            }
          >
            {forceDesktop ? <Smartphone size={16} /> : <Monitor size={16} />}
          </button>
          <button className="btn btn-ghost" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {/* Mobile floating chrome (Jake, 2026-11-02): shown only at
          phone widths (styles.css); the desktop header/sidebar
          arrangement is untouched, and .force-desktop hides all
          of this. Menu circle (top-left) opens the sidebar as a
          drawer; view circle (top-right) is the same desktop-view
          toggle as the header button. */}
      {mobileMenuOpen && (
        <div
          className="mobile-scrim"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
      <button
        type="button"
        className="mobile-fab mobile-menu-btn"
        aria-label="Open menu"
        title="Menu"
        onClick={() => setMobileMenuOpen(true)}
      >
        <Menu size={21} />
      </button>
      <button
        type="button"
        className="mobile-fab mobile-view-btn"
        aria-label={
          forceDesktop
            ? "Switch back to the mobile layout"
            : "Show the desktop layout"
        }
        title={
          forceDesktop
            ? "Switch back to the mobile layout"
            : "Show the desktop layout"
        }
        onClick={() => setForceDesktop(!forceDesktop)}
      >
        {forceDesktop ? <Smartphone size={21} /> : <Monitor size={21} />}
      </button>

      {/* Mobile docked top bar — the standard mobile header
          (Jake, 2026-11-02): one fixed glass bar on every view.
          The menu and view circles render ON it (they carry the
          higher z-index), the title is centered, and on patient
          views the Add Patient circle rides in the bar. At phone
          widths the per-view page-head titles are hidden
          (styles.css) — this bar is the title now. */}
      <div className="mobile-topbar">
        <span className="mobile-topbar-title">{mobileTitle}</span>
        {patientActive && tab !== "add" && (
          <button
            type="button"
            className="mobile-topbar-add"
            aria-label="Add Patient"
            title="Add Patient"
            onClick={() => {
              setForceDesktop(false);
              setTab("add");
            }}
          >
            <Plus size={20} />
          </button>
        )}
      </div>

      {/* The DEMO DATA banner and the placeholder KPI/metrics
          row that used to sit between the header and the body
          were removed at Jake's direction (2026-10-31); their
          CSS rules remain in styles.css, unused. */}

      <div className="dashboard-body">
        <aside
          className={
            (sidebarCollapsed ? "sidebar collapsed" : "sidebar") +
            (mobileMenuOpen ? " mobile-open" : "")
          }
          onClick={(e) => {
            // Drawer mode (mobile): any nav tap also closes the
            // drawer. Harmless on desktop (the state is already
            // false and the class only styles at phone widths).
            if ((e.target as HTMLElement).closest("button"))
              setMobileMenuOpen(false);
          }}
        >
          {/* "Main Menu" label and the collapse chevron share one
              row (Jake, 2026-10-31): label left, chevron right.
              The sidebar search that used to sit above the label
              was removed the same day — patient search lives on
              the Patient List page, driving the same query state. */}
          <div className="sidebar-head">
            <p className="nav-group-label">Main Menu</p>
            <button
              className="sidebar-toggle"
              type="button"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {sidebarCollapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
            </button>
          </div>
          <nav className="sidebar-nav" aria-label="Dashboard sections">
            <button
              className={tab === "dashboard" ? "nav-btn active" : "nav-btn"}
              onClick={() => setTab("dashboard")}
              title="Dashboard"
            >
              <span className="nav-icon"><LayoutDashboard size={20} /></span>
              <span className="nav-label">Dashboard</span>
            </button>
            {/* Patients is a direct sidebar button (Jake,
                2026-11-01): the group submenu (Patients /
                Add Patient / Patients Map) was removed in
                pieces — Add Patient moved onto the Patients
                page as a button, Patients Map left the menu
                (its view code stays in place). */}
            <button
              className={patientActive ? "nav-btn active" : "nav-btn"}
              onClick={() => setTab("list")}
              title="Patients"
            >
              <span className="nav-icon"><Users size={20} /></span>
              <span className="nav-label">Patients</span>
            </button>
            {/* Appointment is an ACTION (Jake, 2026-11-02): it
                opens the calendar page with a fresh booking form.
                Calendar is the page itself. */}
            <button
              className="nav-btn"
              onClick={() => {
                setTab("appointment");
                setCalIntent("create");
              }}
              title="Appointment"
            >
              <span className="nav-icon"><CalendarPlus size={20} /></span>
              <span className="nav-label">Appointment</span>
            </button>
            <button
              className={tab === "appointment" ? "nav-btn active" : "nav-btn"}
              onClick={() => setTab("appointment")}
              title="Calendar"
            >
              <span className="nav-icon"><CalendarDays size={20} /></span>
              <span className="nav-label">Calendar</span>
            </button>
            <button
              className={tab === "messages" ? "nav-btn active" : "nav-btn"}
              onClick={() => setTab("messages")}
              title="Messages"
            >
              <span className="nav-icon"><Mail size={20} /></span>
              <span className="nav-label">
                Messages
                {unreadCount > 0 && (
                  <span className="nav-badge">{unreadCount}</span>
                )}
              </span>
            </button>
            <button
              className={tab === "agency" ? "nav-btn active" : "nav-btn"}
              onClick={() => setTab("agency")}
              title="Agency"
            >
              <span className="nav-icon"><Building2 size={20} /></span>
              <span className="nav-label">Agency</span>
            </button>
            <button
              className={tab === "triage" ? "nav-btn active" : "nav-btn"}
              onClick={() => setTab("triage")}
              title="Urgent triage"
            >
              <span className="nav-icon"><Siren size={20} /></span>
              <span className="nav-label">
                Urgent triage
                <span className="tab-badge">{triageTickets.length}</span>
              </span>
            </button>
            <button
              className={tab === "flags" ? "nav-btn active" : "nav-btn"}
              onClick={() => setTab("flags")}
              title="Clinician-reviewed flags"
            >
              <span className="nav-icon"><FlagIcon size={20} /></span>
              <span className="nav-label">
                Flags
                <span className="tab-badge">{openFlags.length}</span>
              </span>
            </button>
          </nav>
          <p className="nav-group-label">Record</p>
          <nav className="sidebar-nav" aria-label="Record sections">
            <button
              className={tab === "reports" ? "nav-btn active" : "nav-btn"}
              onClick={() => {
                // Reports (Jake, 2026-11-06): navigating here
                // expands the Expenses submenu below; clicking
                // again while already on Reports toggles it.
                if (tab === "reports") {
                  setReportsMenuToggled(!reportsExpanded);
                } else {
                  setTab("reports");
                }
              }}
              title="Reports"
              aria-expanded={reportsExpanded}
            >
              <span className="nav-icon"><BarChart3 size={20} /></span>
              <span className="nav-label">Reports</span>
              <span className="nav-chevron">
                {reportsExpanded ? (
                  <ChevronDown size={16} />
                ) : (
                  <ChevronRight size={16} />
                )}
              </span>
            </button>
            {/* Reports submenu (Jake, 2026-11-06): Expenses
                shortcuts — Mileage Report lands on the Expenses
                tab's report card; Generate Concur Report is an
                action that downloads the current month's CSV
                on click (custom periods live on the Reports
                view's export card). */}
            {reportsExpanded && (
              <div className="nav-submenu">
                <p className="nav-submenu-label">Expenses</p>
                <button
                  type="button"
                  className={
                    tab === "expenses" && expensesViaReports
                      ? "nav-sub-btn active"
                      : "nav-sub-btn"
                  }
                  onClick={openMileageReport}
                >
                  Mileage Report
                </button>
                <button
                  type="button"
                  className="nav-sub-btn"
                  onClick={() => void generateConcurReport()}
                  disabled={concurBusy}
                >
                  {concurBusy ? "Generating…" : "Generate Concur Report"}
                </button>
              </div>
            )}
            {/* Expenses (Jake, 2026-11-01): a direct button
                under Record, same treatment as Patients —
                monthly expense reports with mileage live
                behind it. */}
            <button
              className={tab === "expenses" ? "nav-btn active" : "nav-btn"}
              onClick={() => {
                setExpensesViaReports(false);
                setExpensesAutoOpen(false);
                setTab("expenses");
              }}
              title="Expenses"
            >
              <span className="nav-icon"><Receipt size={20} /></span>
              <span className="nav-label">Expenses</span>
            </button>
          </nav>
          <p className="nav-group-label">System</p>
          <nav className="sidebar-nav" aria-label="System sections">
            <button
              className={
                tab === "settings" ||
                tab === "categories" ||
                tab === "audit" ||
                tab === "clinician" ||
                tab === "contacts"
                  ? "nav-btn active"
                  : "nav-btn"
              }
              onClick={() => setTab("settings")}
              title="Settings"
            >
              <span className="nav-icon"><Settings size={20} /></span>
              <span className="nav-label">Settings</span>
            </button>
            <button
              className={
                tab === "integrations" ? "nav-btn active" : "nav-btn"
              }
              onClick={() => setTab("integrations")}
              title="Integrations"
            >
              <span className="nav-icon"><Blocks size={20} /></span>
              <span className="nav-label">Integrations</span>
            </button>
            <button
              className={tab === "help" ? "nav-btn active" : "nav-btn"}
              onClick={() => setTab("help")}
              title="Help Center"
            >
              <span className="nav-icon"><LifeBuoy size={20} /></span>
              <span className="nav-label">Help Center</span>
            </button>
          </nav>
          {/* Drawer-only actions (mobile): theme + sign out live
              in the header on desktop; in the mobile drawer they
              sit at the foot of the menu. */}
          <div className="drawer-actions">
            <button
              type="button"
              className="nav-btn"
              onClick={onToggleTheme}
            >
              {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
              <span className="nav-label">
                {theme === "light" ? "Dark mode" : "Light mode"}
              </span>
            </button>
            <button
              type="button"
              className="nav-btn"
              onClick={handleSignOut}
            >
              <X size={17} />
              <span className="nav-label">Sign out</span>
            </button>
          </div>
        </aside>

        <main className="app-main">
          {apiStatus === "fallback" && (
            <div className="demo-banner" role="status">
              Patient API unreachable — showing in-browser demo data.
              Changes made here are not saved to the demo database.
            </div>
          )}
          {tab === "dashboard" && (
            <section className="overview-screen">
              <h1>Dashboard</h1>
              <div className="overview-cards">
                <div
                  className={`stat-card clock-card season-${seasonOf(now)} daypart-${daypartOf(now)}${daypartOf(now) === "night" ? " is-night" : ""}`}
                >
                  <div className="clock-when">
                    <p className="clock-time">
                      {now.toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                    <p className="clock-date">
                      {now.toLocaleDateString([], {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                  </div>
                  <div className="clock-weather">
                    {weatherIcon}
                    <span>
                      {weather ? weather.label : "Weather unavailable"}
                    </span>
                  </div>
                </div>
                <div className={`stat-card appt-card ${apptBand}`}>
                  <CalendarCheck size={20} className="stat-icon" />
                  <p className="stat-value">
                    {todayApptCount ?? "—"}
                  </p>
                  <p className="stat-label">Appointments today</p>
                </div>
                <div className="stat-card total-card">
                  <Users size={20} className="stat-icon" />
                  <p className="stat-value">{people.length}</p>
                  <p className="stat-label">Total patients</p>
                </div>
              </div>
              <div className="overview-panels">
                {apiStatus === "connected" ? (
                  <TasksPanel
                    variant="overview"
                    user={user}
                    visible={tab === "dashboard"}
                    people={people}
                    onOpenPatient={openPatientById}
                  />
                ) : (
                  <div className="overview-panel">
                    <h2>My reminders</h2>
                    <p className="section-note">
                      Reminders need the patient API connection.
                    </p>
                  </div>
                )}
                <NewsCard
                  user={user}
                  apiConnected={apiStatus === "connected"}
                />
              </div>
            </section>
          )}

          {tab === "clinician" && staff !== null && (
            <section>
              <h1>Clinician</h1>
              <div className="flag-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => setTab("settings")}
                >
                  ← Back to Settings
                </button>
              </div>
              <p className="section-note">
                Staff directory from the users table — everyone on the
                team. Adding, editing, and deactivating staff is
                limited to managers and admins. Deactivating keeps the
                record and its history, and Reactivate can undo it.
              </p>
              {isManager && (
                <div className="profile-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => requestStaffAction({ kind: "add" })}
                  >
                    Add clinician
                  </button>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => setShowStaffImport((v) => !v)}
                  >
                    Import from Google Contacts
                  </button>
                </div>
              )}
              {showStaffImport && (
                <GoogleContactPicker
                  mode="multi"
                  onPick={(picked) => {
                    setShowStaffImport(false);
                    requestStaffAction({
                      kind: "import",
                      candidates: picked,
                    });
                  }}
                  onClose={() => setShowStaffImport(false)}
                />
              )}
              {staffNotice && <p className="pin-error">{staffNotice}</p>}
              {confirmingDeactivate && (
                <div className="pin-panel">
                  <p>
                    Deactivate {confirmingDeactivate.fname}{" "}
                    {confirmingDeactivate.lname}? They stop being active
                    and assignable, but the record and its history are
                    kept, and Reactivate can undo this.
                  </p>
                  {deactivateError && (
                    <p className="pin-error">{deactivateError}</p>
                  )}
                  <div className="profile-actions">
                    <button
                      className="btn btn-danger"
                      type="button"
                      onClick={() => void handleConfirmDeactivate()}
                    >
                      Deactivate
                    </button>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() => setConfirmingDeactivate(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {staffForm && (
                <form className="add-form" onSubmit={handleSaveStaff}>
                  <h3>
                    {staffForm.member ? "Edit clinician" : "Add clinician"}
                  </h3>
                  <label>
                    First name *
                    <input
                      value={sfFname}
                      onChange={(e) => setSfFname(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Middle name
                    <input
                      value={sfMname}
                      onChange={(e) => setSfMname(e.target.value)}
                    />
                  </label>
                  <label>
                    Last name *
                    <input
                      value={sfLname}
                      onChange={(e) => setSfLname(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Suffix / Credential
                    <select
                      value={sfSuffix}
                      onChange={(e) => setSfSuffix(e.target.value)}
                    >
                      <option value="">None</option>
                      {sfSuffix !== "" &&
                        !STAFF_CREDENTIALS.includes(sfSuffix) && (
                          <option value={sfSuffix}>{sfSuffix}</option>
                        )}
                      {STAFF_CREDENTIALS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Position
                    <select
                      value={sfPosition}
                      onChange={(e) => setSfPosition(e.target.value)}
                    >
                      <option value="">None</option>
                      {sfPosition !== "" &&
                        !STAFF_POSITIONS.includes(sfPosition) && (
                          <option value={sfPosition}>{sfPosition}</option>
                        )}
                      {STAFF_POSITIONS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Email *
                    <input
                      type="email"
                      value={sfEmail}
                      onChange={(e) => setSfEmail(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Role
                    <select
                      value={sfRole}
                      onChange={(e) =>
                        setSfRole(e.target.value as StaffRole)
                      }
                    >
                      {STAFF_ROLES.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Title
                    <input
                      value={sfTitle}
                      onChange={(e) => setSfTitle(e.target.value)}
                      placeholder="e.g. PT, DPT"
                    />
                  </label>
                  <label>
                    Specialty
                    <input
                      value={sfSpecialty}
                      onChange={(e) => setSfSpecialty(e.target.value)}
                    />
                  </label>
                  <label>
                    Cell phone
                    <input
                      value={sfPhoneCell}
                      inputMode="tel"
                      onChange={(e) =>
                        setSfPhoneCell(formatUSPhone(e.target.value))
                      }
                    />
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={sfAuthorized}
                      onChange={(e) => setSfAuthorized(e.target.checked)}
                    />
                    Authorized — can be assigned patients
                  </label>
                  {sfError && <p className="pin-error">{sfError}</p>}
                  <div className="profile-actions">
                    <button
                      className="btn btn-primary"
                      type="submit"
                      disabled={sfSaving}
                    >
                      {sfSaving ? "Saving…" : "Save"}
                    </button>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() => setStaffForm(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
              {/* Clinical / non-clinical grouping (Jake,
                  2026-10-30): split on the users.authorized
                  provider flag — see staffGroups(). The card
                  layout and every action inside it are unchanged;
                  the Patients button keeps its existing render
                  rule (active members), so in practice it appears
                  in the clinical group. */}
              {staffGroups(staff).map((group) => (
                <div key={group.heading}>
                  <h2 className="staff-group-heading">
                    {group.heading}
                  </h2>
                  {group.members.length === 0 ? (
                    <p className="section-note">{group.empty}</p>
                  ) : (
                    <div className="stat-grid">
                      {group.members.map((m) => {
                        const positionLine = staffPositionLine(m);
                  // Phone line: cell preferred, then phone; both
                  // when both exist (deduped). Tap-to-call links.
                  const phoneNumbers = staffPhoneNumbers(m);
                  // Patients assigned to this clinician (Jake,
                  // 2026-10-30: "Patients" button on the card).
                  // The patients table's clinician field is FREE
                  // TEXT, not a users FK, so assignment is matched
                  // on name: the full name as rendered on the card
                  // first, then first + last name; comparisons are
                  // trimmed and case-insensitive.
                  const clinicianOf = (p: PersonUnderCare) =>
                    (p.clinician ?? "").trim().toLowerCase();
                  const fullNameKey = staffFullName(m).toLowerCase();
                  const firstLastKey = `${m.fname} ${m.lname}`
                    .trim()
                    .toLowerCase();
                  const byFullName = people.filter(
                    (p) => clinicianOf(p) !== "" && clinicianOf(p) === fullNameKey,
                  );
                  // ACTIVE patients only (Jake, 2026-10-30):
                  // patientStatus carries active/hold/discharged;
                  // a missing value counts as active, the same
                  // convention the profile status bar uses.
                  const isActive = (p: PersonUnderCare) =>
                    (p.patientStatus ?? "active") === "active";
                  const assignedPatients = (
                    byFullName.length > 0
                      ? byFullName
                      : people.filter(
                          (p) =>
                            clinicianOf(p) !== "" &&
                            clinicianOf(p) === firstLastKey,
                        )
                  )
                    .filter(isActive)
                    .slice()
                    .sort((a, b) =>
                      a.name
                        .toLowerCase()
                        .localeCompare(b.name.toLowerCase()),
                    );
                  const patientsOpen = patientsOpenFor === m.id;
                  return (
                    <article key={m.id} className="card">
                      <div className="card-top">
                        <span
                          className={`avatar-circle ${m.active ? "avatar-active" : "avatar-inactive"}`}
                        >
                          {initials(`${m.fname} ${m.lname}`)}
                        </span>
                        <strong>{staffFullName(m)}</strong>
                      </div>
                      <hr className="card-divider" />
                      <p className="card-meta">{positionLine}</p>
                      <p className="card-meta">{m.email}</p>
                      {phoneNumbers.length > 0 && (
                        <p className="card-meta">
                          {phoneNumbers.map((num, i) => (
                            <span key={num}>
                              {i > 0 ? " · " : ""}
                              {telHref(num) ? (
                                <a
                                  className="address-link"
                                  href={callingHref(num) ?? "#"}
                                  title="Call this number"
                                >
                                  {formatUSPhone(num)}
                                </a>
                              ) : (
                                formatUSPhone(num)
                              )}
                            </span>
                          ))}
                        </p>
                      )}
                      <div className="profile-actions">
                        {isManager && (
                          <>
                            <button
                              className="btn btn-secondary"
                              type="button"
                              onClick={() =>
                                requestStaffAction({ kind: "edit", member: m })
                              }
                            >
                              Edit
                            </button>
                            {m.active ? (
                              <button
                                className="btn btn-danger"
                                type="button"
                                onClick={() =>
                                  requestStaffAction({
                                    kind: "deactivate",
                                    member: m,
                                  })
                                }
                              >
                                Deactivate
                              </button>
                            ) : (
                              <button
                                className="btn btn-secondary"
                                type="button"
                                onClick={() =>
                                  requestStaffAction({
                                    kind: "restore",
                                    member: m,
                                  })
                                }
                              >
                                Reactivate
                              </button>
                            )}
                          </>
                        )}
                        {m.active && (
                          <button
                            className="btn btn-secondary"
                            type="button"
                            aria-expanded={patientsOpen}
                            onClick={() =>
                              setPatientsOpenFor(patientsOpen ? null : m.id)
                            }
                          >
                            Patients
                          </button>
                        )}
                      </div>
                      {m.active && patientsOpen && (
                        <div className="staff-patients">
                          {assignedPatients.length === 0 ? (
                            <p className="card-meta">
                              No active patients assigned
                            </p>
                          ) : (
                            <table className="patients-table">
                              <thead>
                                <tr>
                                  <th>Full name</th>
                                </tr>
                              </thead>
                              <tbody>
                                {assignedPatients.map((p) => (
                                  <tr
                                    key={p.id}
                                    className="patient-table-row"
                                    onClick={() => {
                                      setSelectedId(p.id);
                                      setTab("profile");
                                    }}
                                  >
                                    <td>
                                      <span className="patient-name">
                                        {p.name}
                                      </span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </article>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
              {staff.length === 0 && (
                <p className="section-note">
                  No staff members yet — add the first one above.
                </p>
              )}
            </section>
          )}

          {tab === "clinician" && staff === null && (
            <section>
              <h1>Clinician</h1>
              <div className="flag-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => setTab("settings")}
                >
                  ← Back to Settings
                </button>
              </div>
              <p className="section-note">
                Clinicians derived from the demo patient list — add a
                patient with a clinician name and they show up here.
              </p>
              <div className="stat-grid">
                {clinicians.map((c) => (
                  <article key={c.name} className="card">
                    <div className="card-top">
                      <strong>{c.name}</strong>
                      <span className="card-meta">
                        {c.patients.length}{" "}
                        {c.patients.length === 1 ? "patient" : "patients"}
                      </span>
                    </div>
                    <p>
                      <span className="dot dot-green" /> {c.green} green ·{" "}
                      <span className="dot dot-yellow" /> {c.yellow} yellow ·{" "}
                      <span className="dot dot-red" /> {c.red} red
                    </p>
                    <p className="card-meta">
                      {c.patients.map((p) => p.name).join(", ")}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          )}

          {tab === "list" && (
            // Single column: the "Schedule — today" aside was
            // removed (Jake, 2026-10-30), so the patient table
            // spans the full width — same .single pattern as
            // the Dashboard overview.
            <section className="people-layout single">
              <div className="patient-list-panel">
                {apiStatus === "connected" && (
                  <MergeReview
                    user={user}
                    visible={tab === "list"}
                    isManager={isManager}
                    onMerged={handleMerged}
                    onOpenPatient={openPatientById}
                  />
                )}
                {/* Mobile floating search (Jake, 2026-11-02):
                    translucent, fixed under the title row, with
                    the funnel status filter at its right end.
                    Shares the query state with the desktop search
                    below (which phones hide). Search searches ALL
                    patients and overrides the status filter. */}
                <div className="patients-floating-search">
                  <Search size={17} />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search patients…"
                    aria-label="Search patients"
                  />
                  {query && (
                    <button
                      type="button"
                      className="pfs-clear"
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      <XCircle size={17} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="pfs-funnel"
                    aria-label="Filter patients by status"
                    title="Filter by status"
                    onClick={() => setFilterPanelOpen(!filterPanelOpen)}
                  >
                    <Filter size={18} />
                    {patientStatusFilter !== "active" && (
                      <span className="pfs-badge" />
                    )}
                  </button>
                </div>
                {filterPanelOpen && (
                  <div className="patients-filter-popover">
                    <p className="pfp-label">Status</p>
                    <div className="pfp-chips">
                      {(
                        [
                          ["active", "Active"],
                          ["hold", "On hold"],
                          ["discharged", "Discharged"],
                          ["all", "All statuses"],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={
                            patientStatusFilter === value
                              ? "pfp-chip on"
                              : "pfp-chip"
                          }
                          onClick={() => {
                            setPatientStatusFilter(value);
                            setFilterPanelOpen(false);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <p className="section-note mobile-count-note">
                  {searching
                    ? `${visiblePeople.length} matching ${visiblePeople.length === 1 ? "person" : "people"} — searching all patients`
                    : `${mobilePeople.length} ${patientStatusFilter === "active" ? "active patients" : patientStatusFilter === "hold" ? "patients on hold" : patientStatusFilter === "discharged" ? "discharged patients" : "patients · all statuses"}`}
                </p>
                <div className="page-head list-page-head">
                  <h1>Patients</h1>
                  {/* Add Patient lives on the page now (Jake,
                      2026-11-01) — the sidebar submenu entries
                      were removed the same day. On mobile the
                      button collapses to a + icon (styles.css). */}
                  <button
                    className="btn btn-primary add-patient-btn"
                    type="button"
                    onClick={() => setTab("add")}
                    title="Add Patient"
                  >
                    <Plus size={18} />
                    <span className="add-patient-label">Add Patient</span>
                  </button>
                </div>
                {/* Page search (Jake, 2026-10-30) — replaces the
                    zone legend; drives the shared query state and
                    visiblePeople filters from it. (The sidebar
                    search that used to share this state was
                    removed 2026-10-31.) Styled like the agency
                    search, clear button included. */}
                <div className="agency-search-row">
                  <label className="agency-search">
                    <Search size={15} />
                    <input
                      ref={listSearchRef}
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search patients by name…"
                      aria-label="Search patients"
                    />
                    {query && (
                      <button
                        type="button"
                        className="agency-search-clear"
                        aria-label="Clear search"
                        title="Clear search"
                        onClick={(e) => {
                          e.preventDefault();
                          setQuery("");
                          listSearchRef.current?.focus();
                        }}
                      >
                        <XCircle size={17} />
                      </button>
                    )}
                  </label>
                </div>
                {q && (
                  <p className="section-note">
                    {visiblePeople.length} matching{" "}
                    {visiblePeople.length === 1 ? "person" : "people"} for
                    "{query}".
                  </p>
                )}
                <div className="patients-table-scroll">
                <table className="patients-table">
                  <thead>
                    <tr>
                      <th>
                        <button
                          type="button"
                          className="th-sort"
                          onClick={() => toggleListSort("name")}
                        >
                          Patient
                          {listSort.key === "name"
                            ? listSort.dir === 1
                              ? " ↑"
                              : " ↓"
                            : ""}
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="th-sort"
                          onClick={() => toggleListSort("address")}
                        >
                          Address
                          {listSort.key === "address"
                            ? listSort.dir === 1
                              ? " ↑"
                              : " ↓"
                            : ""}
                        </button>
                      </th>
                      {/* Call column (mobile only, Jake 2026-10-31):
                          header stays empty; the cells hold a tel:
                          icon link. CSS hides the whole column on
                          desktop. */}
                      <th className="col-call" aria-hidden="true"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPeople.map((p) => {
                      // Mobile row actions (Jake, 2026-10-31): the
                      // directions icon replaces the address text on
                      // phones, and the call icon dials the main
                      // number (home phone when usable, else cell).
                      // Both icons stopPropagation so a tap never
                      // also opens the profile via the row onClick.
                      const directionsUrl = mapsDirectionsUrl(p);
                      const mainPhone = telHref(p.phoneHome)
                        ? p.phoneHome
                        : p.phoneCell;
                      const callHref = callingHref(mainPhone);
                      return (
                        <tr
                          key={p.id}
                          className="patient-table-row"
                          title={statusLabel(p.status)}
                          onClick={() => {
                            setSelectedId(p.id);
                            setTab("profile");
                          }}
                        >
                          <td>
                            <span className={`dot dot-${p.status}`} />{" "}
                            <span className="patient-name">
                              {listName(p)}
                            </span>
                          </td>
                          <td>
                            <span
                              className={
                                directionsUrl ? "address-text" : undefined
                              }
                            >
                              {listAddressText(p) || "—"}
                            </span>
                            {directionsUrl ? (
                              <a
                                className="address-directions table-icon-link"
                                href={directionsUrl}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`Directions to ${listAddressText(p) || p.name}`}
                                title={`Directions to ${listAddressText(p)}`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Navigation size={18} />
                              </a>
                            ) : null}
                          </td>
                          <td className="col-call">
                            {callHref ? (
                              <a
                                className="table-icon-link"
                                href={callHref}
                                aria-label={`Call ${p.name}`}
                                title={`Call ${formatUSPhone(mainPhone ?? "")}`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Phone size={18} />
                              </a>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
                {/* Mobile patient cards (Jake, 2026-11-02): zone
                    dot + name (+ status word when not active) +
                    directions/call buttons; NO address on the
                    card. Tap opens the profile, same as a row. */}
                <div className="patient-cards">
                  {mobilePeople.map((p) => {
                    const directionsUrl = mapsDirectionsUrl(p);
                    const mainPhone = telHref(p.phoneHome)
                      ? p.phoneHome
                      : p.phoneCell;
                    const callHref = callingHref(mainPhone);
                    const lifecycle = p.patientStatus ?? "active";
                    return (
                      <div
                        key={p.id}
                        className="patient-card"
                        role="button"
                        title={statusLabel(p.status)}
                        onClick={() => {
                          setSelectedId(p.id);
                          setTab("profile");
                        }}
                      >
                        <span className={`dot dot-${p.status}`} />
                        <span className="pc-main">
                          <span className="patient-name">
                            {listName(p)}
                          </span>
                          {lifecycle !== "active" && (
                            <span className="pc-status">
                              {lifecycle === "hold"
                                ? "On hold"
                                : "Discharged"}
                            </span>
                          )}
                        </span>
                        {directionsUrl ? (
                          <a
                            className="pc-icon-btn"
                            href={directionsUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Directions to ${p.name}`}
                            title="Directions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Navigation size={18} />
                          </a>
                        ) : null}
                        {callHref ? (
                          <a
                            className="pc-icon-btn"
                            href={callHref}
                            aria-label={`Call ${p.name}`}
                            title={`Call ${formatUSPhone(mainPhone ?? "")}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Phone size={18} />
                          </a>
                        ) : null}
                      </div>
                    );
                  })}
                  {mobilePeople.length === 0 && (
                    <p className="section-note">
                      {searching
                        ? "No patients match that search."
                        : "No patients with that status."}
                    </p>
                  )}
                </div>
                {sortedPeople.length === 0 && (
                  <p className="section-note">
                    No patients match that search.
                  </p>
                )}
              </div>
            </section>
          )}

          {tab === "profile" && (
            <section className="profile-layout">
              {/* The patient selector panel was removed (Jake,
                  2026-10-30): the card spans the full width and
                  switching patients happens from the Patient
                  List tab (row click → profile). The heading
                  stays — it reads cleanly above the card. */}
              <h1 className="profile-heading">Patient Profile</h1>
              {/* Mobile-only position + steppers (the heading is
                  hidden on phones; this row shows there instead). */}
              {(() => {
                const idx = mobilePeople.findIndex(
                  (p) => p.id === selectedId,
                );
                if (idx < 0) return null;
                return (
                  <div className="profile-position">
                    <button
                      type="button"
                      aria-label="Previous patient"
                      disabled={idx <= 0}
                      onClick={() => swipeProfile("prev")}
                    >
                      ‹
                    </button>
                    <span>
                      {idx + 1} of {mobilePeople.length}
                    </span>
                    <button
                      type="button"
                      aria-label="Next patient"
                      disabled={idx >= mobilePeople.length - 1}
                      onClick={() => swipeProfile("next")}
                    >
                      ›
                    </button>
                  </div>
                );
              })()}
              {/* Mobile vertical action pill (Jake, 2026-11-02):
                  floating on the right edge, icons only — Call,
                  Directions, Edit. Phone widths only (styles.css);
                  the handlers mirror the profile's own buttons. */}
              {(() => {
                const mainPhone = telHref(selectedPerson.phoneHome)
                  ? selectedPerson.phoneHome
                  : selectedPerson.phoneCell;
                const callHref = callingHref(mainPhone);
                const directionsUrl = mapsDirectionsUrl(selectedPerson);
                return (
                  <div className="profile-vpill">
                    {callHref ? (
                      <a
                        className="vpill-btn primary"
                        href={callHref}
                        aria-label={`Call ${selectedPerson.name}`}
                        title={`Call ${formatUSPhone(mainPhone ?? "")}`}
                      >
                        <Phone size={20} />
                      </a>
                    ) : null}
                    {directionsUrl ? (
                      <a
                        className="vpill-btn"
                        href={directionsUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Directions to ${selectedPerson.name}`}
                        title="Directions"
                      >
                        <Navigation size={20} />
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className="vpill-btn"
                      aria-label="Edit patient"
                      title="Edit patient"
                      onClick={() => {
                        if (!editing && !confirmingDelete) startEdit();
                      }}
                    >
                      <Pencil size={20} />
                    </button>
                  </div>
                );
              })()}
              <article
                key={selectedPerson.id}
                className={
                  "profile-card" +
                  (swipeDir ? ` swipe-${swipeDir}` : "")
                }
                onTouchStart={(e) => {
                  profileTouchRef.current = {
                    x: e.touches[0].clientX,
                    y: e.touches[0].clientY,
                  };
                }}
                onTouchEnd={(e) => {
                  const start = profileTouchRef.current;
                  profileTouchRef.current = null;
                  if (!start) return;
                  const dx = e.changedTouches[0].clientX - start.x;
                  const dy = e.changedTouches[0].clientY - start.y;
                  if (
                    Math.abs(dx) > 56 &&
                    Math.abs(dx) > 1.6 * Math.abs(dy)
                  ) {
                    swipeProfile(dx < 0 ? "next" : "prev");
                  }
                }}
              >
                <div
                  className="profile-head tappable"
                  role="button"
                  title="Tap to edit"
                  onClick={() => {
                    if (!editing && !confirmingDelete) startEdit();
                  }}
                >
                  <span className="avatar-circle">
                    {initials(selectedPerson.name)}
                  </span>
                  <div>
                    <h2>{selectedPerson.name}</h2>
                    <p className="profile-sub">
                      {[selectedAgeSex, statusLabel(selectedPerson.status)]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {selectedPerson.agencyName && (
                      <p className="profile-sub">
                        Agency: {selectedPerson.agencyName}
                      </p>
                    )}
                  </div>
                  {/* Visible Edit button (Jake, 2026-10-30): the
                      header tap alone wasn't discoverable. Same
                      flow as the header tap — opens the Edit form
                      directly — and hidden while the form or the
                      delete confirm is already open (same guards).
                      Icon-only (Pencil) since 2026-10-31, per Jake. */}
                  {!editing && !confirmingDelete && (
                    <button
                      type="button"
                      className="btn btn-secondary profile-edit-btn"
                      title="Edit patient"
                      aria-label="Edit patient"
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit();
                      }}
                    >
                      <Pencil size={17} />
                    </button>
                  )}
                </div>
                <div
                  className={`status-bar status-bar-${
                    selectedPerson.patientStatus === "hold"
                      ? "yellow"
                      : selectedPerson.patientStatus === "discharged"
                        ? "red"
                        : "green"
                  }`}
                  title={
                    selectedPerson.patientStatus === "hold"
                      ? "On hold"
                      : selectedPerson.patientStatus === "discharged"
                        ? "Discharged"
                        : "Active"
                  }
                />
                {confirmingDelete && (
                  <div className="pin-panel">
                    <p>
                      Delete {selectedPerson.name}? This is a soft delete
                      — the record and its audit history are kept, and it
                      can be restored.
                    </p>
                    {deleteError && <p className="pin-error">{deleteError}</p>}
                    <div className="profile-actions">
                      <button
                        className="btn btn-danger"
                        type="button"
                        onClick={() => void handleConfirmDelete()}
                      >
                        Delete patient
                      </button>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => setConfirmingDelete(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {editing && (
                  <form className="add-form" onSubmit={handleSaveEdit}>
                    <h3>Edit patient</h3>
                    <label>
                      First name *
                      <input
                        value={editFname}
                        onChange={(e) => setEditFname(e.target.value)}
                        required
                      />
                    </label>
                    <label>
                      Middle name
                      <input
                        value={editMname}
                        onChange={(e) => setEditMname(e.target.value)}
                      />
                    </label>
                    <label>
                      Last name *
                      <input
                        value={editLname}
                        onChange={(e) => setEditLname(e.target.value)}
                        required
                      />
                    </label>
                    <label>
                      Date of birth
                      <input
                        type="date"
                        value={editDob}
                        onChange={(e) => setEditDob(e.target.value)}
                      />
                    </label>
                    <label>
                      Age (if birth date unknown)
                      <input
                        type="number"
                        min={0}
                        max={130}
                        inputMode="numeric"
                        value={editAge}
                        onChange={(e) => setEditAge(e.target.value)}
                      />
                    </label>
                    <label>
                      Sex
                      <select
                        value={editSex}
                        onChange={(e) => setEditSex(e.target.value)}
                      >
                        <option value="">Select…</option>
                        <option value="Female">Female</option>
                        <option value="Male">Male</option>
                        <option value="Intersex">Intersex</option>
                        <option value="Other">Other</option>
                        <option value="Unknown">Unknown</option>
                      </select>
                    </label>
                    <h3>Contact</h3>
                    <label>
                      Home phone
                      <input
                        value={editPhoneHome}
                        inputMode="tel"
                        onChange={(e) =>
                          setEditPhoneHome(formatUSPhone(e.target.value))
                        }
                      />
                    </label>
                    <label>
                      Cell phone
                      <input
                        value={editPhoneCell}
                        inputMode="tel"
                        onChange={(e) =>
                          setEditPhoneCell(formatUSPhone(e.target.value))
                        }
                      />
                    </label>
                    <div className="form-field">
                      <span>Street</span>
                      <AddressAutocomplete
                        value={editStreet}
                        onChange={(v) => {
                          setEditStreet(v);
                          setEditLat(null);
                          setEditLng(null);
                        }}
                        onSelectAddress={(a) => {
                          setEditStreet(a.street);
                          setEditCity(a.city);
                          setEditState(a.state);
                          setEditPostalCode(a.postal_code);
                          setEditLat(a.latitude);
                          setEditLng(a.longitude);
                        }}
                      />
                    </div>
                    <label>
                      Street line 2
                      <input
                        value={editStreetLine2}
                        onChange={(e) => setEditStreetLine2(e.target.value)}
                        placeholder="Apt / suite"
                      />
                    </label>
                    <label>
                      City
                      <input
                        value={editCity}
                        onChange={(e) => setEditCity(e.target.value)}
                      />
                    </label>
                    <div className="form-row">
                      <label>
                        State
                        <StateSelect
                          value={editState}
                          onChange={setEditState}
                        />
                      </label>
                      <label>
                        Postal code
                        <input
                          value={editPostalCode}
                          onChange={(e) =>
                            setEditPostalCode(e.target.value)
                          }
                        />
                      </label>
                    </div>
                    <label>
                      Status
                      <select
                        value={editStatus}
                        onChange={(e) =>
                          setEditStatus(e.target.value as PatientStatus)
                        }
                      >
                        <option value="active">Active</option>
                        <option value="hold">On hold</option>
                        <option value="discharged">Discharged</option>
                      </select>
                    </label>
                    <label>
                      Note
                      <textarea
                        rows={3}
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                      />
                    </label>
                    <div className="form-field">
                      <span>Agency</span>
                      <AgencyPicker
                        user={user}
                        apiConnected={apiStatus === "connected"}
                        agencyId={editAgencyId}
                        agencyNameText={editAgencyText || null}
                        onChange={(sel) => {
                          setEditAgencyId(sel.agencyId);
                          setEditAgencyText(sel.agencyNameText ?? "");
                        }}
                        patientCity={editCity}
                        resetKey={selectedPerson.id}
                      />
                    </div>
                    {editError && <p className="pin-error">{editError}</p>}
                    <div className="profile-actions">
                      <button
                        className="btn btn-primary"
                        type="submit"
                        disabled={editSaving}
                      >
                        {editSaving ? "Saving…" : "Save changes"}
                      </button>
                      {isManager && (
                        <button
                          className="btn btn-danger"
                          type="button"
                          onClick={() => {
                            setEditing(false);
                            setConfirmingDelete(true);
                          }}
                        >
                          Delete patient
                        </button>
                      )}
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => setEditing(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
                {!editing && (
                  <>
                <h3>Contact</h3>
                <div className="profile-details">
                  <div>
                    <span>Address</span>
                    <strong>
                      {mapsDirectionsUrl(selectedPerson) ? (
                        <a
                          className="address-link"
                          href={mapsDirectionsUrl(selectedPerson) ?? "#"}
                          target="_blank"
                          rel="noreferrer"
                          title="Open in Google Maps for directions"
                        >
                          {fullAddressText(selectedPerson)}
                        </a>
                      ) : (
                        "—"
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>Home phone</span>
                    <strong>
                      {telHref(selectedPerson.phoneHome) ? (
                        <a
                          className="address-link"
                          href={callingHref(selectedPerson.phoneHome) ?? "#"}
                          title="Call this number"
                        >
                          {formatUSPhone(selectedPerson.phoneHome ?? "")}
                        </a>
                      ) : (
                        "—"
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>Cell phone</span>
                    <strong>
                      {telHref(selectedPerson.phoneCell) ? (
                        <a
                          className="address-link"
                          href={callingHref(selectedPerson.phoneCell) ?? "#"}
                          title="Call this number"
                        >
                          {formatUSPhone(selectedPerson.phoneCell ?? "")}
                        </a>
                      ) : (
                        "—"
                      )}
                    </strong>
                  </div>
                </div>
                
                <div className="profile-actions">
                  {(selectedPerson.patientStatus ?? "active") !==
                    "hold" && (
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={statusSaving}
                      onClick={() => void handleSetPatientStatus("hold")}
                    >
                      Put on hold
                    </button>
                  )}
                  {(selectedPerson.patientStatus ?? "active") !==
                    "discharged" && (
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={statusSaving}
                      onClick={() =>
                        void handleSetPatientStatus("discharged")
                      }
                    >
                      Discharge
                    </button>
                  )}
                  {(selectedPerson.patientStatus ?? "active") !==
                    "active" && (
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={statusSaving}
                      onClick={() => void handleSetPatientStatus("active")}
                    >
                      Return to active
                    </button>
                  )}
                  {apiStatus === "connected" &&
                    (!confirmingUnlink ? (
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => setConfirmingUnlink(true)}
                      >
                        Remove from my list
                      </button>
                    ) : (
                      <>
                        <button
                          className="btn btn-primary"
                          type="button"
                          onClick={() => void handleRemoveFromList()}
                        >
                          Confirm remove
                        </button>
                        <button
                          className="btn btn-secondary"
                          type="button"
                          onClick={() => setConfirmingUnlink(false)}
                        >
                          Keep
                        </button>
                      </>
                    ))}
                </div>
                {statusError && <p className="pin-error">{statusError}</p>}
                {unlinkError && <p className="pin-error">{unlinkError}</p>}
                {apiStatus === "connected" && (
                  <p className="section-note">
                    Hold, Discharge, and Remove apply to your list only —
                    the shared record and your colleagues' lists are
                    untouched.
                  </p>
                )}
                {apiStatus === "connected" && (
                  <div className="dup-mark">
                    {!dupPickerOpen ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                          setDupPickerOpen(true);
                          setDupNote("");
                        }}
                      >
                        Mark as duplicate…
                      </button>
                    ) : (
                      <div className="dup-picker">
                        <input
                          type="search"
                          value={dupQuery}
                          onChange={(e) => setDupQuery(e.target.value)}
                          placeholder="Search for the other record…"
                          aria-label="Search for the other record"
                        />
                        <div className="dup-results">
                          {people
                            .filter(
                              (p) =>
                                p.id !== selectedPerson.id &&
                                p.name
                                  .toLowerCase()
                                  .includes(dupQuery.trim().toLowerCase()),
                            )
                            .slice(0, 8)
                            .map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                className="dup-result"
                                disabled={dupBusy}
                                onClick={() =>
                                  void handleMarkDuplicate(p.id, p.name)
                                }
                              >
                                <span>{p.name}</span>
                                <span className="dup-result-sub">
                                  {[p.dateOfBirth, p.city, p.state]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              </button>
                            ))}
                          {people.filter(
                            (p) =>
                              p.id !== selectedPerson.id &&
                              p.name
                                .toLowerCase()
                                .includes(dupQuery.trim().toLowerCase()),
                          ).length === 0 && (
                            <p className="section-note">
                              No other patient matches.
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => setDupPickerOpen(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {dupNote && <p className="section-note">{dupNote}</p>}
                  </div>
                )}
                <h3>Appointments</h3>
                {selectedDay.length === 0 &&
                  selectedReminders.length === 0 && (
                    <p className="section-note">
                      No upcoming appointments in this demo.
                    </p>
                  )}
                <ul className="schedule-list">
                  {selectedDay.map((e) => (
                    <li key={e.id} className="schedule-item">
                      <span className="agenda-time">{e.time}</span>
                      <span>
                        <strong>Today</strong> — {e.title}
                      </span>
                    </li>
                  ))}
                  {selectedReminders.map((r) => (
                    <li key={r.id} className="schedule-item">
                      <span className="agenda-time">{r.due}</span>
                      <span>
                        {r.title} ({r.kind})
                      </span>
                    </li>
                  ))}
                </ul>
                  </>
                )}
              </article>
              {apiStatus === "connected" && (
                <PatientMessages
                  user={user}
                  patientApiId={selectedPerson.id}
                />
              )}
              {apiStatus === "connected" && (
                <TasksPanel
                  key={`tasks-${selectedPerson.id}`}
                  variant="patient"
                  user={user}
                  patientId={selectedPerson.id}
                />
              )}
              {apiStatus === "connected" && (
                <ClinicalDocuments
                  user={user}
                  patientApiId={selectedPerson.id}
                />
              )}
              {apiStatus === "connected" && (
                <EpisodeCard
                  key={`episode-${selectedPerson.id}`}
                  user={user}
                  patientId={selectedPerson.id}
                />
              )}
            </section>
          )}

          {tab === "add" && (
            <section>
              <div className="gform-head">
                <button
                  className="gform-back"
                  type="button"
                  onClick={() => setTab("list")}
                  aria-label="Back to patients"
                >
                  <ArrowLeft size={20} />
                </button>
                <span className="gform-title">Add Patient</span>
                <span className="gform-spacer" />
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => setShowTextIntake((v) => !v)}
                >
                  Paste
                </button>
                <button
                  className="btn btn-primary"
                  type="submit"
                  form="add-patient-form"
                >
                  Save
                </button>
              </div>
              {showTextIntake && (
                <TextIntake
                  onApply={(candidate, referrer) => {
                    applyContactToPatientForm(candidate);
                    if (referrer) setFormReferrer(referrer);
                    setShowTextIntake(false);
                  }}
                  onClose={() => setShowTextIntake(false)}
                />
              )}
              <form
                className="add-form gform"
                id="add-patient-form"
                onSubmit={handleAddPatient}
              >
                {addFormError && (
                  <div className="dup-panel" role="alert">
                    <p>{addFormError}</p>
                  </div>
                )}
                <div className="gform-row">
                  <span className="gform-ico">
                    <UserIcon size={20} />
                  </span>
                  <div className="gform-fields">
                    <input
                      value={formFname}
                      onChange={(e) => setFormFname(e.target.value)}
                      required
                      placeholder="First name"
                      aria-label="First name"
                    />
                    <input
                      value={formLname}
                      onChange={(e) => setFormLname(e.target.value)}
                      required
                      placeholder="Last name"
                      aria-label="Last name"
                    />
                  </div>
                </div>
                {(dupChecking || dupMatches.length > 0) && (
                  <div className="dup-panel" role="alert">
                    {dupMatches.length === 0 ? (
                      <p>Checking records…</p>
                    ) : (
                      <>
                        <p>
                          <strong>Possible Duplicate</strong>
                        </p>
                        <ul>
                          {dupMatches.map((m) => (
                            <li key={m.id}>
                              <span>
                                {m.name} — {shortDob(m.dob)}
                              </span>
                              <button
                                type="button"
                                className="dup-open"
                                onClick={() => {
                                  setSelectedId(m.id);
                                  setTab("profile");
                                }}
                              >
                                OPEN
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
                {dupConflict && (
                  <div className="dup-panel" role="alert">
                    {dupConflict.kind === "exists" &&
                    dupConflict.patient ? (
                      <>
                        <p>
                          <strong>Already in our database</strong>
                        </p>
                        <p>
                          {dupConflict.patient.name} —{" "}
                          {shortDob(dupConflict.patient.dob)}
                          {dupConflict.patient.city
                            ? ` · ${dupConflict.patient.city}`
                            : ""}{" "}
                          is already registered, so a second record
                          can't be created. Add the existing patient
                          to your list instead.
                        </p>
                        <div className="flag-actions">
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={dupActionBusy}
                            onClick={() =>
                              void handleLinkExisting(
                                dupConflict.patient!.id,
                              )
                            }
                          >
                            {dupConflict.patient.already_linked
                              ? "Open patient"
                              : "Add to my list"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={dupActionBusy}
                            onClick={() => setDupConflict(null)}
                          >
                            Keep editing
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p>
                          <strong>
                            Possible match — is this the same person?
                          </strong>
                        </p>
                        <ul>
                          {(dupConflict.candidates ?? []).map((c) => (
                            <li key={c.id}>
                              <span>
                                {c.name} — {shortDob(c.dob)}
                                {c.city ? ` · ${c.city}` : ""}
                              </span>
                              <button
                                type="button"
                                className="dup-open"
                                disabled={dupActionBusy}
                                onClick={() =>
                                  void handleLinkExisting(c.id)
                                }
                              >
                                ADD THIS ONE INSTEAD
                              </button>
                            </li>
                          ))}
                        </ul>
                        <div className="flag-actions">
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={dupActionBusy}
                            onClick={() => void handleCreateAnyway()}
                          >
                            No — create a new patient
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={dupActionBusy}
                            onClick={() => setDupConflict(null)}
                          >
                            Keep editing
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
                <div className="gform-row">
                  <span className="gform-ico">
                    <Cake size={20} />
                  </span>
                  <div className="gform-fields">
                    <span className="gform-cap">Date of birth</span>
                    <input
                      type="date"
                      value={formDob}
                      onChange={(e) => setFormDob(e.target.value)}
                      aria-label="Date of birth"
                    />
                    <div className="form-row">
                      <input
                        type="number"
                        min={0}
                        max={130}
                        inputMode="numeric"
                        value={formAge}
                        onChange={(e) => setFormAge(e.target.value)}
                        placeholder="Age"
                        aria-label="Age"
                      />
                      <select
                        value={formSex}
                        onChange={(e) => setFormSex(e.target.value)}
                        aria-label="Sex"
                      >
                        <option value="">Sex</option>
                        <option value="Female">Female</option>
                        <option value="Male">Male</option>
                        <option value="Intersex">Intersex</option>
                        <option value="Other">Other</option>
                        <option value="Unknown">Unknown</option>
                      </select>
                    </div>
                  </div>
                </div>
                <div className="gform-row">
                  <span className="gform-ico">
                    <Phone size={20} />
                  </span>
                  <div className="gform-fields">
                    <input
                      value={formPhoneCell}
                      inputMode="tel"
                      onChange={(e) =>
                        setFormPhoneCell(formatUSPhone(e.target.value))
                      }
                      placeholder="Cell phone"
                      aria-label="Cell phone"
                    />
                  </div>
                </div>
                <div className="gform-row">
                  <span className="gform-ico">
                    <Mail size={20} />
                  </span>
                  <div className="gform-fields">
                    <input
                      value={formEmail}
                      inputMode="email"
                      onChange={(e) => setFormEmail(e.target.value)}
                      placeholder="Email"
                      aria-label="Email"
                    />
                  </div>
                </div>
                <div className="gform-row">
                  <span className="gform-ico">
                    <MapPin size={20} />
                  </span>
                  <div className="gform-fields">
                    <div className="form-field">
                      <AddressAutocomplete
                        value={formStreet}
                        onChange={(v) => {
                          setFormStreet(v);
                          setFormLat(null);
                          setFormLng(null);
                        }}
                        onSelectAddress={(a) => {
                          setFormStreet(a.street);
                          setFormCity(a.city);
                          setFormState(a.state);
                          setFormPostalCode(a.postal_code);
                          setFormLat(a.latitude);
                          setFormLng(a.longitude);
                        }}
                      />
                    </div>
                    <input
                      value={formCity}
                      onChange={(e) => setFormCity(e.target.value)}
                      placeholder="City"
                      aria-label="City"
                    />
                    <div className="form-row">
                      <StateSelect value={formState} onChange={setFormState} />
                      <input
                        value={formPostalCode}
                        onChange={(e) => setFormPostalCode(e.target.value)}
                        placeholder="Postal code"
                        aria-label="Postal code"
                      />
                    </div>
                  </div>
                </div>
                <div className="gform-row">
                  <span className="gform-ico">
                    <Building2 size={20} />
                  </span>
                  <div className="gform-fields">
                    <div className="form-field">
                      <AgencyPicker
                        user={user}
                        apiConnected={apiStatus === "connected"}
                        agencyId={formAgencyId}
                        agencyNameText={formAgencyText || null}
                        onChange={(sel) => {
                          setFormAgencyId(sel.agencyId);
                          setFormAgencyText(sel.agencyNameText ?? "");
                        }}
                        patientCity={formCity}
                        resetKey="add-patient"
                      />
                    </div>
                  </div>
                </div>
                <div className="gform-row">
                  <span className="gform-ico">
                    <ClipboardCheck size={20} />
                  </span>
                  <div className="gform-fields">
                    <span className="gform-cap">Status</span>
                    <select
                      value={formStatus}
                      onChange={(e) =>
                        setFormStatus(e.target.value as PatientStatus)
                      }
                      aria-label="Status"
                    >
                      <option value="active">Active</option>
                      <option value="hold">On hold</option>
                      <option value="discharged">Discharged</option>
                    </select>
                  </div>
                </div>
                <div className="gform-row">
                  <span className="gform-ico">
                    <FileText size={20} />
                  </span>
                  <div className="gform-fields">
                    <textarea
                      rows={3}
                      value={formNote}
                      onChange={(e) => setFormNote(e.target.value)}
                      placeholder="Notes"
                      aria-label="Notes"
                    />
                  </div>
                </div>
                {(() => {
                  const optionalFields: Array<{
                    key: string;
                    label: string;
                    Icon: typeof Phone;
                  }> = [
                    { key: "mname", label: "Middle name", Icon: UserIcon },
                    { key: "phoneHome", label: "Home phone", Icon: Phone },
                    { key: "street2", label: "Street line 2", Icon: MapPin },
                    { key: "referrer", label: "Referred by", Icon: Users },
                  ];
                  const remaining = optionalFields.filter(
                    (f) => !addedFields.includes(f.key),
                  );
                  const removeField = (key: string) => {
                    if (key === "mname") setFormMname("");
                    if (key === "phoneHome") setFormPhoneHome("");
                    if (key === "street2") setFormStreetLine2("");
                    if (key === "referrer") setFormReferrer("");
                    setAddedFields((prev) => prev.filter((k) => k !== key));
                  };
                  const removeBtn = (key: string, label: string) => (
                    <button
                      className="gform-remove"
                      type="button"
                      aria-label={`Remove ${label}`}
                      onClick={() => removeField(key)}
                    >
                      <X size={16} />
                    </button>
                  );
                  return (
                    <>
                      {addedFields.includes("mname") && (
                        <div className="gform-row">
                          <span className="gform-ico">
                            <UserIcon size={20} />
                          </span>
                          <div className="gform-fields">
                            <input
                              value={formMname}
                              onChange={(e) => setFormMname(e.target.value)}
                              placeholder="Middle name"
                              aria-label="Middle name"
                            />
                          </div>
                          {removeBtn("mname", "Middle name")}
                        </div>
                      )}
                      {addedFields.includes("phoneHome") && (
                        <div className="gform-row">
                          <span className="gform-ico">
                            <Phone size={20} />
                          </span>
                          <div className="gform-fields">
                            <input
                              value={formPhoneHome}
                              inputMode="tel"
                              onChange={(e) =>
                                setFormPhoneHome(formatUSPhone(e.target.value))
                              }
                              placeholder="Home phone"
                              aria-label="Home phone"
                            />
                          </div>
                          {removeBtn("phoneHome", "Home phone")}
                        </div>
                      )}
                      {addedFields.includes("street2") && (
                        <div className="gform-row">
                          <span className="gform-ico">
                            <MapPin size={20} />
                          </span>
                          <div className="gform-fields">
                            <input
                              value={formStreetLine2}
                              onChange={(e) =>
                                setFormStreetLine2(e.target.value)
                              }
                              placeholder="Street line 2 (apt / suite)"
                              aria-label="Street line 2"
                            />
                          </div>
                          {removeBtn("street2", "Street line 2")}
                        </div>
                      )}
                      {addedFields.includes("referrer") && (
                        <div className="gform-row">
                          <span className="gform-ico">
                            <Users size={20} />
                          </span>
                          <div className="gform-fields">
                            <input
                              value={formReferrer}
                              onChange={(e) => setFormReferrer(e.target.value)}
                              placeholder="Referred by"
                              aria-label="Referred by"
                            />
                          </div>
                          {removeBtn("referrer", "Referred by")}
                        </div>
                      )}
                      {remaining.length > 0 && (
                        <div className="gform-addwrap">
                          <button
                            className="gform-more-btn"
                            type="button"
                            onClick={() => setAddMenuOpen((v) => !v)}
                            aria-expanded={addMenuOpen}
                          >
                            <Plus size={16} />
                            Add field
                            <ChevronDown
                              size={16}
                              className={
                                addMenuOpen ? "gform-chev open" : "gform-chev"
                              }
                            />
                          </button>
                          {addMenuOpen && (
                            <>
                              <button
                                className="gform-backdrop"
                                type="button"
                                aria-hidden="true"
                                tabIndex={-1}
                                onClick={() => setAddMenuOpen(false)}
                              />
                              <div className="gform-addmenu" role="menu">
                                {remaining.map(({ key, label, Icon }) => (
                                  <button
                                    key={key}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setAddedFields((prev) => [...prev, key]);
                                      setAddMenuOpen(false);
                                    }}
                                  >
                                    <Icon size={18} />
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}
              </form>
            </section>
          )}

          {tab === "map" && (
            <PatientsMapView
              patients={people}
              onOpenPatient={(id) => {
                setSelectedId(id);
                setTab("profile");
              }}
            />
          )}

          {tab === "appointment" && (
            <CalendarView
              user={user}
              apiConnected={apiStatus === "connected"}
              patients={people.map(toMapPatient)}
              clinicians={(colleagues ?? staff ?? [])
                .filter((s) => s.active && s.authorized)
                .map((s) => ({
                  id: String(s.id),
                  name: `${s.fname} ${s.lname}`,
                }))}
              defaultProviderId={
                me && me.active && me.authorized ? String(me.id) : ""
              }
              intent={calIntent}
              onIntentHandled={() => setCalIntent(null)}
              onOpenPatient={(id) => {
                setSelectedId(id);
                setTab("profile");
              }}
            />
          )}

          {tab === "messages" && (
            <MessagesView
              user={user}
              apiConnected={apiStatus === "connected"}
              staff={staff}
              patients={people}
              onOpenPatient={(apiId) => {
                const p = people.find((x) => x.id === apiId);
                if (p) {
                  setSelectedId(p.id);
                  setTab("profile");
                }
              }}
              onUnreadChange={setUnreadCount}
            />
          )}

          {tab === "agency" && (
            <section>
              <h1>Agency</h1>
              <AgencyView
                user={user}
                apiConnected={apiStatus === "connected"}
              />
            </section>
          )}

          {tab === "triage" && (
            <section>
              <h1>Urgent triage</h1>
              <div className="card-list">
                {sortedTickets.map((t) => (
                  <article key={t.id} className={`card priority-${t.priority}`}>
                    <div className="card-top">
                      <span className="priority-badge">{t.priority}</span>
                      <strong>{t.title}</strong>
                      <span className="card-meta">
                        {t.person} · opened {t.opened}
                      </span>
                    </div>
                    <p>{t.detail}</p>
                    <p className="card-note">
                      Clinician action required — nothing here is automatic.
                    </p>
                  </article>
                ))}
              </div>
            </section>
          )}

          {tab === "flags" && (
            <section>
              <h1>Clinician-reviewed flags</h1>
              <div className="card-list">
                <p className="section-note">
                  How flags work: the system surfaces a signal and a draft
                  suggestion. A clinician reviews every flag and decides —
                  the system never sends a message, books an appointment, or
                  places an order on its own. In this demo, your decision is
                  recorded on this screen only.
                </p>
                {flags.map((f) => (
                  <article key={f.id} className="card">
                    <div className="card-top">
                      <strong>{f.person}</strong>
                      <span className="card-meta">
                        {decisionLabel(f.decision)}
                      </span>
                    </div>
                    <p>{f.signal}</p>
                    <p>{f.suggestion}</p>
                    {f.decision === "open" ? (
                      <div className="flag-actions">
                        <button
                          className="btn btn-primary"
                          onClick={() => decideFlag(f.id, "acknowledged")}
                        >
                          Acknowledge
                        </button>
                        <button
                          className="btn btn-secondary"
                          onClick={() => decideFlag(f.id, "followup")}
                        >
                          Schedule follow-up
                        </button>
                        <button
                          className="btn btn-ghost"
                          onClick={() => decideFlag(f.id, "dismissed")}
                        >
                          Dismiss
                        </button>
                      </div>
                    ) : (
                      <button
                        className="btn btn-ghost"
                        onClick={() => decideFlag(f.id, "open")}
                      >
                        Reopen for review
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}

          {tab === "contacts" && (
            <section>
              <h1>Contacts</h1>
              <div className="flag-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => setTab("settings")}
                >
                  ← Back to Settings
                </button>
              </div>
              {/* Real staff directory (Jake, 2026-10-30): the
                  same users-table rows as the Clinician tab,
                  grouped clinical / non-clinical by the
                  authorized flag, read-only. The fictional
                  "Agency team" placeholders and the derived
                  demo cards are gone; an unreachable API shows
                  an honest unavailable note, never fake
                  contacts. */}
              {staff === null ? (
                <p className="section-note">
                  The staff directory is unavailable — it comes from
                  the CareTask database, which isn't reachable right
                  now.
                </p>
              ) : (
                staffGroups(staff).map((group) => (
                  <div key={group.heading}>
                    <h2 className="staff-group-heading">
                      {group.heading}
                    </h2>
                    {group.members.length === 0 ? (
                      <p className="section-note">{group.empty}</p>
                    ) : (
                      <div className="stat-grid">
                        {group.members.map((m) => {
                          const phoneNumbers = staffPhoneNumbers(m);
                          return (
                            <article key={m.id} className="card">
                              <div className="card-top">
                                <span
                                  className={`avatar-circle ${m.active ? "avatar-active" : "avatar-inactive"}`}
                                >
                                  {initials(`${m.fname} ${m.lname}`)}
                                </span>
                                <strong>{staffFullName(m)}</strong>
                              </div>
                              <hr className="card-divider" />
                              <p className="card-meta">
                                {staffPositionLine(m)}
                              </p>
                              <p className="card-meta">{m.email}</p>
                              {phoneNumbers.length > 0 && (
                                <p className="card-meta">
                                  {phoneNumbers.map((num, i) => (
                                    <span key={num}>
                                      {i > 0 ? " · " : ""}
                                      {telHref(num) ? (
                                        <a
                                          className="address-link"
                                          href={callingHref(num) ?? "#"}
                                          title="Call this number"
                                        >
                                          {formatUSPhone(num)}
                                        </a>
                                      ) : (
                                        formatUSPhone(num)
                                      )}
                                    </span>
                                  ))}
                                </p>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))
              )}
            </section>
          )}

          {tab === "settings" && (
            <section>
              <h1>Settings</h1>
              <div className="card-list">
                <article className="card">
                  <strong>Theme</strong>
                  <div className="flag-actions">
                    <button
                      className={
                        theme === "light"
                          ? "btn btn-primary"
                          : "btn btn-secondary"
                      }
                      onClick={() => {
                        if (theme !== "light") onToggleTheme();
                      }}
                    >
                      Light
                    </button>
                    <button
                      className={
                        theme === "dark"
                          ? "btn btn-primary"
                          : "btn btn-secondary"
                      }
                      onClick={() => {
                        if (theme !== "dark") onToggleTheme();
                      }}
                    >
                      Dark
                    </button>
                  </div>
                  <p className="theme-picker-label">Color theme</p>
                  <div className="theme-chip-grid">
                    {COLOR_THEMES.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={
                          colorTheme === t.id
                            ? "theme-chip active"
                            : "theme-chip"
                        }
                        aria-pressed={colorTheme === t.id}
                        onClick={() => onColorThemeChange(t.id)}
                      >
                        <span className="theme-chip-head">
                          <span className="theme-chip-name">{t.name}</span>
                          {colorTheme === t.id && (
                            <span className="theme-chip-active">Active</span>
                          )}
                        </span>
                        <span className="theme-swatches" aria-hidden="true">
                          <span
                            className="theme-dot"
                            style={{ background: t.light.accent }}
                          />
                          <span
                            className="theme-dot"
                            style={{ background: t.light.secondary }}
                          />
                          <span className="theme-swatch-sep" />
                          <span
                            className="theme-dot"
                            style={{ background: t.dark.accent }}
                          />
                          <span
                            className="theme-dot"
                            style={{ background: t.dark.secondary }}
                          />
                        </span>
                      </button>
                    ))}
                  </div>
                </article>
                <article className="card">
                  <strong>Layout</strong>
                  <div className="flag-actions">
                    <button
                      className={
                        !forceDesktop
                          ? "btn btn-primary"
                          : "btn btn-secondary"
                      }
                      onClick={() => setForceDesktop(false)}
                    >
                      Mobile view
                    </button>
                    <button
                      className={
                        forceDesktop
                          ? "btn btn-primary"
                          : "btn btn-secondary"
                      }
                      onClick={() => setForceDesktop(true)}
                    >
                      Desktop view
                    </button>
                  </div>
                </article>
                <CallingAppSettings />
                <NewsTopicsSettings />
                <VisitCategoriesSettings
                  user={user}
                  apiConnected={apiStatus === "connected"}
                  onListCategories={() => setTab("categories")}
                />
                <AgencyDirectorySettings
                  user={user}
                  apiConnected={apiStatus === "connected"}
                />
                <MyAgenciesCard
                  user={user}
                  apiConnected={apiStatus === "connected"}
                />
                <HomeOfficeCard
                  user={user}
                  apiConnected={apiStatus === "connected"}
                />
                <MileageRatesCard
                  user={user}
                  apiConnected={apiStatus === "connected"}
                />
                <ExpensePolicyCard
                  user={user}
                  apiConnected={apiStatus === "connected"}
                />
                {/* Invites moved to the admin console
                    (admin.marcinnotech.net) in deploy-38,
                    per admin-site-spec.md §8d. */}
                <PhoneContactsCard
                  user={user}
                  apiConnected={apiStatus === "connected"}
                />
                <CsvImport
                  user={user}
                  apiConnected={apiStatus === "connected"}
                  onPatientsImported={(created) =>
                    setPeople((prev) => [...prev, ...created])
                  }
                />
                <article className="card">
                  <div className="card-top">
                    <strong>Personnel</strong>
                  </div>
                  <div className="flag-actions">
                    <button
                      className="btn btn-secondary"
                      onClick={() => setTab("clinician")}
                    >
                      Clinician
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setTab("contacts")}
                    >
                      Contacts
                    </button>
                  </div>
                </article>
                <article className="card">
                  <div className="card-top">
                    <strong>Logging</strong>
                  </div>
                  <div className="flag-actions">
                    <button
                      className="btn btn-secondary"
                      onClick={() => setTab("audit")}
                    >
                      Log
                    </button>
                  </div>
                </article>
              </div>
            </section>
          )}

          {tab === "categories" && (
            <section>
              <h1>Visit categories</h1>
              <div className="flag-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => setTab("settings")}
                >
                  ← Back to Settings
                </button>
              </div>
              <div className="card-list">
                <VisitCategoriesSettings
                  user={user}
                  apiConnected={apiStatus === "connected"}
                  variant="page"
                />
              </div>
            </section>
          )}

          {tab === "integrations" && (
            <section>
              <h1>Integrations</h1>
              <p className="section-note">
                Integrations are configured by an admin. Nothing here sends
                patient data anywhere.
              </p>
              <div className="card-list">
                <article className="card">
                  <div className="card-top">
                    <strong>Firebase Authentication</strong>
                    <span className="kind-badge">Connected</span>
                  </div>
                  <p>
                    Sign-in for clinicians (email/password and Google). New
                    accounts join by invite only — an admin sends one from
                    Settings.
                  </p>
                </article>
                <article className="card">
                  <div className="card-top">
                    <strong>Cloudflare Pages</strong>
                    <span className="kind-badge">Connected</span>
                  </div>
                  <p>Hosts this dashboard.</p>
                </article>
                {["EHR sync", "Lab results", "Calendar sync", "Messaging"].map(
                  (name) => (
                    <article key={name} className="card">
                      <div className="card-top">
                        <strong>{name}</strong>
                        <span className="card-meta">Not connected</span>
                      </div>
                      <p>
                        Available to configure later; no data flows until an
                        admin connects it.
                      </p>
                    </article>
                  ),
                )}
              </div>
            </section>
          )}

          {tab === "help" && (
            <section>
              <h1>Help Center</h1>
              <div className="card-list">
                <article className="card">
                  <strong>How do zones work?</strong>
                  {ZONE_GUIDE.map((z) => (
                    <p key={z.zone}>
                      <span className={`dot dot-${z.zone}`} />{" "}
                      <strong>{z.name}:</strong> {z.meaning} {z.action}
                    </p>
                  ))}
                </article>
                <article className="card">
                  <strong>How do flags work?</strong>
                  <p>
                    The system surfaces a signal and a draft suggestion. A
                    clinician reviews every flag and decides — the system
                    never sends a message, books an appointment, or places an
                    order on its own.
                  </p>
                </article>
                <article className="card">
                  <strong>Where does my work go?</strong>
                  <p>
                    Flag decisions and added patients live in this session
                    only and reset when the page reloads. Everything on this
                    dashboard is demo data.
                  </p>
                </article>
                <article className="card">
                  <strong>How do I add a patient?</strong>
                  <p>
                    Open Patient → Add Patient, fill in the first and last
                    name and zone, and submit. The patient appears in the
                    Patients list and Patient Profile.
                  </p>
                </article>
                <article className="card">
                  <strong>
                    How do I switch themes or see the desktop layout on my
                    phone?
                  </strong>
                  <p>
                    Use the theme and Desktop view buttons in the header, or
                    open Settings — both control the same switches.
                  </p>
                </article>
                <article className="card">
                  <strong>How are new accounts created?</strong>
                  <p>
                    There is no self-registration. An admin creates new
                    clinician accounts in the Firebase console.
                  </p>
                </article>
              </div>
            </section>
          )}

          {tab === "expenses" && (
            <ExpensesView
              user={user}
              people={people}
              apiConnected={apiStatus === "connected"}
              autoOpenCurrent={expensesAutoOpen}
              focusReportNonce={focusReportNonce}
            />
          )}

          {tab === "reports" && (
            <section>
              <div className="page-head">
                <h1>Reports</h1>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={downloadReportPdf}
                >
                  Download PDF
                </button>
              </div>
              <ConcurExportCard user={user} />
              <div className="stat-grid">
                <div className="stat-card">
                  <Users size={20} className="stat-icon" />
                  <p className="stat-value">{analytics.peopleUnderCare}</p>
                  <p className="stat-label">People under care (demo)</p>
                </div>
                <div className="stat-card">
                  <HeartPulse size={20} className="stat-icon" />
                  <p className="stat-value">
                    {analytics.green} / {analytics.yellow} / {analytics.red}
                  </p>
                  <p className="stat-label">Green / yellow / red (demo)</p>
                </div>
                <div className="stat-card">
                  <Siren size={20} className="stat-icon" />
                  <p className="stat-value">{analytics.openTickets}</p>
                  <p className="stat-label">Open triage tickets (demo)</p>
                </div>
                <div className="stat-card">
                  <ClipboardCheck size={20} className="stat-icon" />
                  <p className="stat-value">
                    {analytics.flagsReviewedThisWeek}
                  </p>
                  <p className="stat-label">Flags reviewed this week (demo)</p>
                </div>
                <div className="stat-card">
                  <Clock size={20} className="stat-icon" />
                  <p className="stat-value">
                    {analytics.adminHoursReturnedIllustrative} hrs
                  </p>
                  <p className="stat-label">
                    Admin hours returned, illustrative only (demo)
                  </p>
                </div>
              </div>
              <div className="chart-card">
                <h2>Flags reviewed per week (demo)</h2>
                <svg
                  viewBox="0 0 520 190"
                  className="bar-chart"
                  role="img"
                  aria-label="Bar chart of demo flags reviewed per week"
                >
                  {analytics.weeklyFlagsReviewed.map((value, i) => {
                    const height = (value / maxBar) * 130;
                    const x = 20 + i * 100;
                    const y = 150 - height;
                    return (
                      <g key={analytics.weeklyLabels[i]}>
                        <rect
                          x={x}
                          y={y}
                          width="56"
                          height={height}
                          rx="6"
                          style={{ fill: "var(--teal)" }}
                        />
                        <text
                          x={x + 28}
                          y={y - 8}
                          textAnchor="middle"
                          style={{ fill: "var(--text)" }}
                          fontSize="13"
                        >
                          {value}
                        </text>
                        <text
                          x={x + 28}
                          y={172}
                          textAnchor="middle"
                          style={{ fill: "var(--muted)" }}
                          fontSize="12"
                        >
                          {analytics.weeklyLabels[i]}
                        </text>
                      </g>
                    );
                  })}
                </svg>
                <p className="section-note">
                  Illustrative demo numbers only — not a performance claim.
                </p>
              </div>
            </section>
          )}
          {tab === "audit" && (
            <section>
              <h1>Log</h1>
              <div className="flag-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => setTab("settings")}
                >
                  ← Back to Settings
                </button>
              </div>
              <p className="section-note">
                Every recorded event from the patient API — patient
                views, sign-ins, sign-outs, API calls, and failed
                sign-ins — with a tamper-evident hash chain. The chain
                badge recomputes the chain on the server; a broken
                chain names the first row that fails.
              </p>
              {!isApiConfigured() ? (
                <p className="section-note">
                  The audit log requires the patient API connection.
                  No patient API is configured for this dashboard.
                </p>
              ) : apiStatus === "fallback" ? (
                <p className="section-note">
                  The audit log requires the patient API connection.
                  The API is currently unreachable, so no audit events
                  can be shown.
                </p>
              ) : (
                <>
                  <form
                    className="add-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void loadAudit(0);
                    }}
                  >
                    <label>
                      User email
                      <input
                        value={auditFilterUser}
                        onChange={(e) =>
                          setAuditFilterUser(e.target.value)
                        }
                        placeholder="e.g. jake@ — partial match"
                      />
                    </label>
                    <label>
                      Event type
                      <select
                        value={auditFilterEvent}
                        onChange={(e) =>
                          setAuditFilterEvent(
                            e.target.value as "" | AuditEventName,
                          )
                        }
                      >
                        <option value="">All events</option>
                        {AUDIT_EVENT_OPTIONS.map((ev) => (
                          <option key={ev} value={ev}>
                            {ev}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Patient
                      <select
                        value={auditFilterPatient}
                        onChange={(e) =>
                          setAuditFilterPatient(e.target.value)
                        }
                      >
                        <option value="">All patients</option>
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      From date
                      <input
                        type="date"
                        value={auditFilterFrom}
                        onChange={(e) =>
                          setAuditFilterFrom(e.target.value)
                        }
                      />
                    </label>
                    <label>
                      To date
                      <input
                        type="date"
                        value={auditFilterTo}
                        onChange={(e) =>
                          setAuditFilterTo(e.target.value)
                        }
                      />
                    </label>
                    <button
                      className="btn btn-primary"
                      type="submit"
                      disabled={auditLoading}
                    >
                      Apply filters
                    </button>
                  </form>
                  {auditChain && (
                    <p className="section-note">{chainBadge(auditChain)}</p>
                  )}
                  <div className="agency-search-row">
                    <label className="agency-search">
                      <Search size={15} />
                      <input
                        ref={auditSearchRef}
                        type="search"
                        value={auditSearch}
                        onChange={(e) => setAuditSearch(e.target.value)}
                        placeholder="Search the log…"
                        aria-label="Search the log"
                      />
                      {auditSearch && (
                        <button
                          type="button"
                          className="agency-search-clear"
                          aria-label="Clear search"
                          title="Clear search"
                          onClick={(e) => {
                            e.preventDefault();
                            setAuditSearch("");
                            auditSearchRef.current?.focus();
                          }}
                        >
                          <XCircle size={17} />
                        </button>
                      )}
                    </label>
                    <span className="flag-actions">
                      <button
                        className="btn btn-secondary"
                        type="button"
                        disabled={visibleAuditEvents.length === 0}
                        onClick={exportAuditCsv}
                      >
                        Export
                      </button>
                    </span>
                  </div>
                  {auditLoading && (
                    <p className="section-note">
                      Loading audit events…
                    </p>
                  )}
                  {auditError && (
                    <p className="section-note">{auditError}</p>
                  )}
                  {!auditLoading &&
                    !auditError &&
                    auditEvents.length === 0 && (
                      <p className="section-note">
                        No audit events match these filters.
                      </p>
                    )}
                  {!auditLoading &&
                    !auditError &&
                    auditEvents.length > 0 &&
                    visibleAuditEvents.length === 0 && (
                      <p className="section-note">
                        No log entries match your search.
                      </p>
                    )}
                  {visibleAuditEvents.length > 0 && (
                    <table className="data-table">
                      <thead>
                        <tr>
                          {(
                            [
                              ["event", "Event"],
                              ["actor", "Actor"],
                              ["time", "Time"],
                              ["type", "Type"],
                              ["patient", "Patient"],
                              ["ip", "IP"],
                            ] as [AuditSortKey, string][]
                          ).map(([key, label]) => (
                            <th key={key}>
                              <button
                                type="button"
                                className="th-sort"
                                onClick={() => toggleAuditSort(key)}
                              >
                                {label}
                                {auditSort?.key === key
                                  ? auditSort.dir === 1
                                    ? " ↑"
                                    : " ↓"
                                  : ""}
                              </button>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {visibleAuditEvents.map((e) => (
                          <tr key={e.id}>
                            <td>
                              <strong>{describeEvent(e, people)}</strong>
                            </td>
                            <td>{e.actor_email}</td>
                            <td>
                              {new Date(e.created_at).toLocaleString()}
                            </td>
                            <td>{e.event}</td>
                            <td>{auditPatientName(e) || "—"}</td>
                            <td>{e.ip ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={auditLoading || auditOffset === 0}
                      onClick={() =>
                        void loadAudit(
                          Math.max(0, auditOffset - AUDIT_PAGE_SIZE),
                        )
                      }
                    >
                      Previous
                    </button>{" "}
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={
                        auditLoading ||
                        auditEvents.length < AUDIT_PAGE_SIZE
                      }
                      onClick={() =>
                        void loadAudit(auditOffset + AUDIT_PAGE_SIZE)
                      }
                    >
                      Next
                    </button>
                  </div>
                </>
              )}
            </section>
          )}
        </main>
      </div>

      {/* Mobile floating pill footer (Jake, 2026-11-02): the four
          everyday destinations. Mileage opens Expenses flagged to
          auto-open the current month's report. Phone widths only
          (styles.css). */}
      <nav className="mobile-pill" aria-label="Main">
        <button
          type="button"
          className={tab === "dashboard" ? "mp-item active" : "mp-item"}
          onClick={() => setTab("dashboard")}
        >
          <LayoutDashboard size={21} />
          <span>Dashboard</span>
        </button>
        <button
          type="button"
          className={patientActive ? "mp-item active" : "mp-item"}
          onClick={() => setTab("list")}
        >
          <Users size={21} />
          <span>Patients</span>
        </button>
        <button
          type="button"
          className={tab === "expenses" ? "mp-item active" : "mp-item"}
          onClick={() => {
            setExpensesViaReports(false);
            setExpensesAutoOpen(true);
            setTab("expenses");
          }}
        >
          <Route size={21} />
          <span>Mileage</span>
        </button>
        <button
          type="button"
          className={tab === "appointment" ? "mp-item active" : "mp-item"}
          onClick={() => setTab("appointment")}
        >
          <CalendarDays size={21} />
          <span>Calendar</span>
        </button>
      </nav>
      {/* App toast (2026-11-06): minimal fixed toast driven by
          Dashboard state; first user is the Reports submenu's
          Generate Concur Report action. Auto-dismisses ~6s. */}
      {toast && (
        <div className={`app-toast app-toast-${toast.kind}`} role="status">
          <span>{toast.text}</span>
          <button
            type="button"
            className="app-toast-close"
            onClick={() => setToast(null)}
            aria-label="Dismiss"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
