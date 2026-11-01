// Synthetic demo data. Every person, reading, ticket, and number below is
// invented for demonstration. No real patient data exists anywhere in this
// app, and nothing here is sent to any server.

export type TrafficLight = "green" | "yellow" | "red";

// Zone guide, modeled on Cornell Home Care's traffic-light zones
// (Green / Yellow / Red), worded for the clinician viewing this dashboard:
// each zone states what it means and what the clinician does next.
// Zones classify attention only — the clinician always decides.
export const ZONE_GUIDE: {
  zone: TrafficLight;
  name: string;
  meaning: string;
  action: string;
}[] = [
  {
    zone: "green",
    name: "Green Zone",
    meaning: "Symptoms under control — the person is doing well.",
    action:
      "Continue the care plan as ordered, routine monitoring, and keep appointments.",
  },
  {
    zone: "yellow",
    name: "Yellow Zone",
    meaning: "Changes noticed — something new or concerning.",
    action:
      "Clinician review: contact the person and assess whether the plan or medications need adjustment.",
  },
  {
    zone: "red",
    name: "Red Zone",
    meaning: "Symptoms worsening — the changes are worrisome.",
    action: "Prompt clinician evaluation right away.",
  },
];

export interface PersonUnderCare {
  id: string;
  name: string;
  ageBand: string;
  status: TrafficLight;
  statusNote: string;
  lastCheckIn: string;
  nextReview: string;
  clinician: string;
  // Patients v2 fields (API patients only — the in-browser demo
  // people above predate the v2 schema and leave these unset). `name`
  // is the display name: preferred name when set, else the full
  // split name (title + fname + mname + lname + suffix).
  // ss and drivers_license are deliberately NOT part of the view
  // model: no dashboard view renders them (minimization).
  title?: string | null;
  fname?: string;
  mname?: string | null;
  lname?: string;
  suffix?: string | null;
  preferredName?: string | null;
  dateOfBirth?: string | null;
  // Stored age (years) — only consulted when dateOfBirth is
  // unset (schema-patients-age.sql).
  age?: number | null;
  sex?: string | null;
  race?: string | null;
  ethnicity?: string | null;
  language?: string | null;
  street?: string | null;
  streetLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  // Map coordinates (schema-patients-map.sql) — set only for API
  // patients whose address came from an autocomplete pick.
  latitude?: number | null;
  longitude?: number | null;
  phoneHome?: string | null;
  phoneCell?: string | null;
  email?: string | null;
  occupation?: string | null;
  interpreterNeeded?: boolean | null;
  hipaaAllowsSms?: boolean | null;
  hipaaAllowsEmail?: boolean | null;
  referrer?: string | null;
  patientStatus?: string | null;
  emergencyContactName?: string | null;
  emergencyContactRelationship?: string | null;
  emergencyContactPhone?: string | null;
  billingNote?: string | null;
  pricelevel?: string | null;
  financial?: string | null;
  pharmacyId?: number | null;
  // Agency tag (schema-patients-agency.sql): directory link
  // (agencyId) OR free-text fallback (agencyNameText), never
  // both; agencyName is the resolved display value.
  agencyId?: number | null;
  agencyNameText?: string | null;
  agencyName?: string | null;
}

export interface TriageTicket {
  id: string;
  person: string;
  priority: "P1" | "P2" | "P3";
  title: string;
  detail: string;
  opened: string;
}

export interface Reminder {
  id: string;
  person: string;
  title: string;
  due: string;
  kind: "Visit" | "Screening" | "Lab" | "Vaccine" | "Check-in";
}

export type FlagDecision = "open" | "acknowledged" | "followup" | "dismissed";

export interface Flag {
  id: string;
  person: string;
  signal: string;
  suggestion: string;
  decision: FlagDecision;
}

export const peopleUnderCare: PersonUnderCare[] = [
  {
    id: "p1",
    name: "Rosa D.",
    ageBand: "70s",
    status: "green",
    statusNote: "On track — recent check-in normal",
    lastCheckIn: "Oct 24, 2026",
    nextReview: "Nov 14, 2026",
    clinician: "Dr. Alvarez",
  },
  {
    id: "p2",
    name: "Marcus T.",
    ageBand: "60s",
    status: "yellow",
    statusNote: "Missed one home reading this week",
    lastCheckIn: "Oct 23, 2026",
    nextReview: "Oct 30, 2026",
    clinician: "Dr. Alvarez",
  },
  {
    id: "p3",
    name: "Elena R.",
    ageBand: "80s",
    status: "red",
    statusNote: "Needs prompt clinician review",
    lastCheckIn: "Oct 22, 2026",
    nextReview: "Oct 28, 2026",
    clinician: "P. Nguyen, PT",
  },
  {
    id: "p4",
    name: "James W.",
    ageBand: "50s",
    status: "green",
    statusNote: "On track — therapy progressing",
    lastCheckIn: "Oct 25, 2026",
    nextReview: "Nov 10, 2026",
    clinician: "P. Nguyen, PT",
  },
  {
    id: "p5",
    name: "Priya S.",
    ageBand: "40s",
    status: "yellow",
    statusNote: "Preventive screening overdue",
    lastCheckIn: "Oct 20, 2026",
    nextReview: "Nov 2, 2026",
    clinician: "Dr. Alvarez",
  },
  {
    id: "p6",
    name: "Harold B.",
    ageBand: "80s",
    status: "red",
    statusNote: "Two abnormal readings in a row",
    lastCheckIn: "Oct 21, 2026",
    nextReview: "Oct 28, 2026",
    clinician: "Dr. Alvarez",
  },
  {
    id: "p7",
    name: "Maya L.",
    ageBand: "30s",
    status: "green",
    statusNote: "On track — routine follow-up only",
    lastCheckIn: "Oct 26, 2026",
    nextReview: "Nov 20, 2026",
    clinician: "P. Nguyen, PT",
  },
  {
    id: "p8",
    name: "Tom K.",
    ageBand: "60s",
    status: "yellow",
    statusNote: "Lab review still pending",
    lastCheckIn: "Oct 19, 2026",
    nextReview: "Nov 4, 2026",
    clinician: "Dr. Alvarez",
  },
];

export interface DayScheduleEntry {
  id: string;
  minutes: number; // minutes from midnight, for plotting on the day calendar
  time: string;
  person: string;
  title: string;
}

// Demo day schedule (fictional, for today). Times are plotted on the day
// calendar in the dashboard; nothing here is a real appointment.
export const daySchedule: DayScheduleEntry[] = [
  { id: "d1", minutes: 510, time: "8:30 AM", person: "Elena R.", title: "Prompt review visit" },
  { id: "d2", minutes: 570, time: "9:30 AM", person: "Harold B.", title: "Reading re-check" },
  { id: "d3", minutes: 630, time: "10:30 AM", person: "Marcus T.", title: "Device setup review" },
  { id: "d4", minutes: 780, time: "1:00 PM", person: "Priya S.", title: "Screening appointment" },
  { id: "d5", minutes: 870, time: "2:30 PM", person: "Tom K.", title: "Lab results review" },
  { id: "d6", minutes: 930, time: "3:30 PM", person: "James W.", title: "Therapy progress visit" },
];

export const triageTickets: TriageTicket[] = [
  {
    id: "t1",
    person: "Harold B.",
    priority: "P1",
    title: "Two abnormal readings in a row",
    detail: "Demo readings only. A clinician should review before any action.",
    opened: "Oct 26, 2026",
  },
  {
    id: "t2",
    person: "Elena R.",
    priority: "P1",
    title: "Missed scheduled check-in",
    detail: "Demo entry. Suggested next step: clinician places a check-in call.",
    opened: "Oct 25, 2026",
  },
  {
    id: "t3",
    person: "Priya S.",
    priority: "P2",
    title: "Preventive screening overdue",
    detail: "Demo entry. Suggested next step: clinician offers a screening slot.",
    opened: "Oct 24, 2026",
  },
  {
    id: "t4",
    person: "Marcus T.",
    priority: "P2",
    title: "Home reading gap this week",
    detail: "Demo entry. Suggested next step: clinician reviews device setup.",
    opened: "Oct 23, 2026",
  },
  {
    id: "t5",
    person: "Tom K.",
    priority: "P3",
    title: "Lab review pending",
    detail: "Demo entry. Routine — review at the next visit unless it changes.",
    opened: "Oct 22, 2026",
  },
];

export const reminders: Reminder[] = [
  { id: "r1", person: "Elena R.", title: "Prompt review visit", due: "Oct 28, 2026", kind: "Visit" },
  { id: "r2", person: "Harold B.", title: "Reading re-check", due: "Oct 29, 2026", kind: "Check-in" },
  { id: "r3", person: "Marcus T.", title: "Device setup review", due: "Oct 30, 2026", kind: "Visit" },
  { id: "r4", person: "Priya S.", title: "Screening appointment", due: "Nov 2, 2026", kind: "Screening" },
  { id: "r5", person: "Tom K.", title: "Lab results review", due: "Nov 4, 2026", kind: "Lab" },
  { id: "r6", person: "James W.", title: "Therapy progress visit", due: "Nov 10, 2026", kind: "Visit" },
  { id: "r7", person: "Rosa D.", title: "Annual check-in", due: "Nov 14, 2026", kind: "Check-in" },
  { id: "r8", person: "Maya L.", title: "Flu vaccine", due: "Nov 20, 2026", kind: "Vaccine" },
];

export const initialFlags: Flag[] = [
  {
    id: "f1",
    person: "Harold B.",
    signal: "Demo signal: two readings outside the usual range.",
    suggestion: "Suggested draft: clinician reviews readings and decides the next step.",
    decision: "open",
  },
  {
    id: "f2",
    person: "Elena R.",
    signal: "Demo signal: scheduled check-in not recorded.",
    suggestion: "Suggested draft: clinician places a check-in call.",
    decision: "open",
  },
  {
    id: "f3",
    person: "Priya S.",
    signal: "Demo signal: preventive screening past due.",
    suggestion: "Suggested draft: clinician offers a screening appointment.",
    decision: "open",
  },
  {
    id: "f4",
    person: "Marcus T.",
    signal: "Demo signal: one home reading missing this week.",
    suggestion: "Suggested draft: clinician checks device setup at next contact.",
    decision: "open",
  },
];

export const analytics = {
  peopleUnderCare: 48,
  green: 34,
  yellow: 11,
  red: 3,
  openTickets: 5,
  flagsReviewedThisWeek: 27,
  adminHoursReturnedIllustrative: 6.5,
  weeklyFlagsReviewed: [18, 22, 19, 25, 27],
  weeklyLabels: ["Sep 29", "Oct 6", "Oct 13", "Oct 20", "Oct 27"],
};
