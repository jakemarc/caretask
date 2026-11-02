// Google Contacts (People API) import for the CareTask dashboard.
// PROTOTYPE built 2026-10-30 (see workspace/marc-innotech/
// people-api-research.md for the full research note).
//
// How it works:
// - The signed-in user connects THEIR OWN Google account with the
//   read-only contacts scope, via the Google Identity Services token
//   client. The access token lives in memory only, for the one fetch;
//   nothing is synced, stored server-side, or refreshed later.
// - We request only the personFields the import maps (names, emails,
//   phones, addresses, birthdays, genders, occupations,
//   organizations, biographies) — field-mask minimization is built
//   into the API and we use it.
// - Fetched contacts are normalized to ContactCandidate and handed to
//   the caller, which decides what a pick means: the Add Patient form
//   pre-fills (clinician reviews, duplicate check runs, Save is the
//   normal path), and the Clinician tab creates staff records through
//   the existing role-gated API. This module never writes
//   anywhere itself.
// - When VITE_GOOGLE_OAUTH_CLIENT_ID is not configured, the picker
//   offers SAMPLE contacts (fictional, Person-shaped) so the whole
//   flow can be tried end to end before the Google Cloud setup
//   exists.
//
// Data-handling notes (Google API Services User Data Policy /
// Limited Use): contacts are fetched only on the user's explicit
// click, used only for the import the user is looking at, never sent
// anywhere except the user's own CareTask API when they confirm a
// pick, and never retained by this module after the picker closes.

export interface GooglePerson {
  resourceName?: string;
  names?: {
    displayName?: string;
    givenName?: string;
    familyName?: string;
    middleName?: string;
  }[];
  emailAddresses?: { value?: string; type?: string }[];
  phoneNumbers?: { value?: string; type?: string }[];
  addresses?: {
    streetAddress?: string;
    extendedAddress?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    countryCode?: string;
  }[];
  birthdays?: { date?: { year?: number; month?: number; day?: number } }[];
  genders?: { value?: string }[];
  occupations?: { value?: string }[];
  organizations?: { name?: string; title?: string }[];
  biographies?: { value?: string }[];
}

// The dashboard-shaped contact the picker returns. Empty string =
// the contact didn't carry that field; mapping to a patient/staff
// form is the caller's job.
export interface ContactCandidate {
  resourceName: string;
  displayName: string;
  fname: string;
  mname: string;
  lname: string;
  email: string;
  phoneHome: string;
  phoneCell: string;
  street: string;
  streetLine2: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
  dob: string; // YYYY-MM-DD or ""
  sex: string; // dashboard value ("Female" | "Male" | "Other") or ""
  occupation: string;
  organization: string;
  orgTitle: string;
  note: string;
}

const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
const PERSON_FIELDS =
  "names,emailAddresses,phoneNumbers,addresses,birthdays,genders,occupations,organizations,biographies";

export function googleClientId(): string {
  const raw =
    (import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID as string | undefined) ??
    "";
  return raw.trim();
}

export function isGoogleImportConfigured(): boolean {
  return googleClientId() !== "";
}

// ------------------------------------------------------------------
// Google Identity Services token client (loaded on demand).

interface GisTokenResponse {
  access_token?: string;
  error?: string;
}

interface GisTokenClient {
  requestAccessToken: (opts?: { prompt?: string }) => void;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (cfg: {
            client_id: string;
            scope: string;
            callback: (resp: GisTokenResponse) => void;
            error_callback?: (err: { type?: string; message?: string }) => void;
          }) => GisTokenClient;
        };
      };
    };
  }
}

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    const script = existing ?? document.createElement("script");
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        window.clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 10000) {
        window.clearInterval(timer);
        reject(new Error("Google sign-in didn't load — check the connection."));
      }
    }, 100);
    if (!existing) {
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        window.clearInterval(timer);
        reject(new Error("Google sign-in didn't load — check the connection."));
      };
      document.head.appendChild(script);
    }
  });
}

// Ask the user to connect their Google account (consent popup) and
// resolve with a short-lived access token for the contacts scope.
export async function requestContactsAccessToken(): Promise<string> {
  const clientId = googleClientId();
  if (!clientId) {
    throw new Error("Google import isn't configured yet.");
  }
  await loadGis();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new Error("Google sign-in didn't load.");
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: CONTACTS_SCOPE,
      callback: (resp) => {
        if (resp.access_token) resolve(resp.access_token);
        else reject(new Error(resp.error ?? "Google didn't grant access."));
      },
      error_callback: (err) => {
        reject(
          new Error(
            err.type === "popup_closed"
              ? "The Google window was closed before finishing."
              : (err.message ?? "Google sign-in failed."),
          ),
        );
      },
    });
    client.requestAccessToken();
  });
}

// ------------------------------------------------------------------
// People API read. Paginated connections.list, capped at 5 pages
// (5,000 contacts) — far beyond a clinic's address book, and the cap
// keeps a runaway account from stalling the import.

export async function fetchGoogleContacts(
  accessToken: string,
): Promise<ContactCandidate[]> {
  const out: ContactCandidate[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const params = new URLSearchParams({
      personFields: PERSON_FIELDS,
      pageSize: "1000",
      sortOrder: "FIRST_NAME_ASCENDING",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(
      `https://people.googleapis.com/v1/people/me/connections?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) {
      throw new Error(`Google Contacts request failed: ${res.status}`);
    }
    const body = (await res.json()) as {
      connections?: GooglePerson[];
      nextPageToken?: string;
    };
    for (const person of body.connections ?? []) {
      out.push(personToCandidate(person));
    }
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export function personToCandidate(p: GooglePerson): ContactCandidate {
  const name = p.names?.[0] ?? {};
  let fname = name.givenName ?? "";
  let lname = name.familyName ?? "";
  const displayName =
    name.displayName ?? [fname, lname].filter(Boolean).join(" ");
  if (!fname && !lname && displayName) {
    const parts = displayName.trim().split(/\s+/);
    fname = parts[0] ?? "";
    lname = parts.length > 1 ? parts[parts.length - 1] : "";
  }
  const phones = p.phoneNumbers ?? [];
  const byType = (t: string) =>
    phones.find((ph) => (ph.type ?? "").toLowerCase() === t)?.value ?? "";
  const addr = p.addresses?.[0] ?? {};
  const bday = p.birthdays?.[0]?.date;
  const dob =
    bday?.year && bday?.month && bday?.day
      ? `${bday.year}-${String(bday.month).padStart(2, "0")}-${String(bday.day).padStart(2, "0")}`
      : "";
  const gender = (p.genders?.[0]?.value ?? "").toLowerCase();
  return {
    resourceName: p.resourceName ?? displayName,
    displayName: displayName || "(no name)",
    fname,
    mname: name.middleName ?? "",
    lname,
    email: p.emailAddresses?.[0]?.value ?? "",
    phoneHome: byType("home"),
    phoneCell: byType("mobile") || (phones[0]?.value ?? ""),
    street: addr.streetAddress ?? "",
    streetLine2: addr.extendedAddress ?? "",
    city: addr.city ?? "",
    state: addr.region ?? "",
    postalCode: addr.postalCode ?? "",
    countryCode: addr.countryCode ?? "",
    dob,
    sex:
      gender === "female"
        ? "Female"
        : gender === "male"
          ? "Male"
          : gender === "other"
            ? "Other"
            : "",
    occupation: p.occupations?.[0]?.value ?? "",
    organization: p.organizations?.[0]?.name ?? "",
    orgTitle: p.organizations?.[0]?.title ?? "",
    note: p.biographies?.[0]?.value ?? "",
  };
}

// ------------------------------------------------------------------
// Sample contacts (fictional) — the full picker + mapping flow with
// no Google account involved. Person-shaped on purpose: they go
// through personToCandidate exactly like real API results.

export const SAMPLE_PEOPLE: GooglePerson[] = [
  {
    resourceName: "people/sample-1",
    names: [
      {
        displayName: "Gloria Alvarez",
        givenName: "Gloria",
        familyName: "Alvarez",
      },
    ],
    emailAddresses: [{ value: "gloria.alvarez@example.com", type: "home" }],
    phoneNumbers: [
      { value: "555-0142", type: "mobile" },
      { value: "555-0143", type: "home" },
    ],
    addresses: [
      {
        streetAddress: "1204 W Fulton St",
        city: "Chicago",
        region: "IL",
        postalCode: "60661",
        countryCode: "US",
      },
    ],
    birthdays: [{ date: { year: 1949, month: 6, day: 18 } }],
    genders: [{ value: "female" }],
    occupations: [{ value: "Retired teacher" }],
  },
  {
    resourceName: "people/sample-2",
    names: [
      {
        displayName: "Peter Novak",
        givenName: "Peter",
        familyName: "Novak",
        middleName: "J",
      },
    ],
    emailAddresses: [{ value: "peter.novak@example.com", type: "work" }],
    phoneNumbers: [{ value: "555-0117", type: "mobile" }],
    addresses: [
      {
        streetAddress: "8821 S Roberts Rd",
        extendedAddress: "Apt 2B",
        city: "Justice",
        region: "IL",
        postalCode: "60458",
        countryCode: "US",
      },
    ],
    birthdays: [{ date: { year: 1955, month: 11, day: 2 } }],
    genders: [{ value: "male" }],
  },
  {
    resourceName: "people/sample-3",
    names: [
      { displayName: "June Park", givenName: "June", familyName: "Park" },
    ],
    emailAddresses: [{ value: "june.park@example.com", type: "home" }],
    phoneNumbers: [{ value: "555-0199", type: "mobile" }],
    organizations: [{ name: "Palos Community Hospital", title: "RN" }],
    occupations: [{ value: "Registered nurse" }],
  },
  {
    resourceName: "people/sample-4",
    names: [
      {
        displayName: "Sam Whitaker",
        givenName: "Sam",
        familyName: "Whitaker",
      },
    ],
    emailAddresses: [{ value: "sam.whitaker@example.com", type: "work" }],
    phoneNumbers: [
      { value: "555-0123", type: "work" },
      { value: "555-0124", type: "mobile" },
    ],
    organizations: [{ name: "Marc Innotech", title: "Office Manager" }],
  },
];

export function sampleCandidates(): ContactCandidate[] {
  return SAMPLE_PEOPLE.map(personToCandidate);
}
