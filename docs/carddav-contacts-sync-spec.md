# CareTask — Phone Contacts Sync (CardDAV) — Specification

Status: **BUILT + DEPLOYED as deploy-36 (2026-11-03)** —
written 2026-11-03 at Jake's direction ("Spec the CardDAV
route"); Jake approved the build ("go") the same day, adopting
the §13 defaults. API + Radicale + dashboard are live; public
reachability waits on the contacts.marcinnotech.net DNS
record (Caddy TLS follows automatically), and Jake's iPhone
pilot is the final verification.
Decisions already locked by Jake (2026-11-03): live sync (not a
one-off export); the phone list is named **CareTask**; the
CardDAV route over the Google Contacts route.

## 1. Goal

A clinician's **Active** patients in CareTask appear in their
phone's native Contacts app, in their own list named
**CareTask** — so a patient's call shows their name, and the
patient is one tap to call or navigate to. CareTask stays the
system of record; the phone list is a live, read-only mirror
of each clinician's own list.

## 2. Why CardDAV (and not Google Contacts)

From `people-api-research.md` (2026-10-30): Google Contacts /
the People API is **not** on Google's Workspace BAA included
list, so synced patient info would sit outside any BAA, in a
personal account, beyond our audit and deletion control.
CardDAV is an open standard (RFC 6352, vCard RFC 6350): we
run the server ourselves, on the same VM and under the same
controls as the CareTask API, and every phone platform speaks
it natively (iOS built in; Android via DAVx5). No third party
ever holds the data.

## 3. Architecture

```
CareTask API (Node, marcinnotech-api VM)
  └─ contact-sync module
       ├─ reads: patient_links (list_status = 'active') + patients
       ├─ writes: CardDAV over HTTPS as service user "ctsync"
       └─ Radicale (Python CardDAV server, same VM, :5232)
            ├─ per-clinician principal: /<sync_user>/
            │    └─ address book, display name "CareTask"
            ├─ auth: htpasswd (bcrypt)
            └─ rights file: clinician = READ-ONLY own book;
               ctsync = read/write ALL books
  └─ Caddy: contacts.marcinnotech.net → 127.0.0.1:5232 (TLS)
       └─ iPhone: CardDAV account → Contacts app → Lists → CareTask
```

- **Server: Radicale 3.x.** Small pure-Python CalDAV/CardDAV
  server, fits the e2-micro next to the API; multifilesystem
  storage (one .vcf per contact — inspectable, easy backup);
  htpasswd auth and a regex rights file support exactly our
  model (a real-world pattern: per-user read-only books + one
  internal sync user that writes all books). Alternatives
  considered: Baïkal (PHP + admin UI, heavier), Nextcloud
  (far too heavy for this VM), SabreDAV (a library, not a
  server — more code for us to own).
- **Topology:** systemd unit `radicale` on the VM, bound to
  localhost; Caddy terminates TLS at
  **contacts.marcinnotech.net** (new A record in Cloudflare
  DNS → 34.57.183.32, proxy OFF, same as `api`). DAV clients
  use HTTP Basic and cannot follow interactive login flows —
  the host must NOT sit behind any SSO/Access gate; Radicale's
  own auth is the gate.
- **One address book per clinician**, created under their own
  principal, display name exactly **CareTask**. On the phone
  it appears as the CareTask list under their CardDAV account
  (Contacts → Lists).

## 4. Data model additions (API)

Schema sketch (final shape set at build):

```sql
-- one row per clinician who enables phone sync
CREATE TABLE user_contact_sync (
  user_id        BIGINT PRIMARY KEY REFERENCES users(id),
  dav_username   TEXT UNIQUE NOT NULL,     -- e.g. 'u7' (opaque, not an email)
  enabled        BOOLEAN NOT NULL DEFAULT false,
  book_path      TEXT,                     -- /u7/<book-uuid>/ once created
  last_sync_at   TIMESTAMPTZ,
  last_result    TEXT,                     -- 'ok' | error summary (no contact data)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- per-contact sync state (etag cache + drift detection)
CREATE TABLE contact_sync_items (
  user_id     BIGINT NOT NULL REFERENCES users(id),
  patient_id  UUID   NOT NULL REFERENCES patients(id),
  dav_href    TEXT   NOT NULL,             -- /u7/<book>/<patient-uuid>.vcf
  dav_etag    TEXT,
  content_hash TEXT  NOT NULL,             -- sha256 of the canonical vCard body
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, patient_id)
);
```

- The clinician's CardDAV **password is never stored in our
  database.** It lives only as a bcrypt hash in Radicale's
  htpasswd file (managed by the API via a small root-owned
  helper on the VM, or an API-side htpasswd writer + service
  reload — implementation detail to settle in build; Radicale
  htpasswd changes may need a reload, which is sub-second and
  acceptable at password-set time only).
- The sync service credential (`ctsync`) lives in the API's
  `.env` on the VM (mode 600), like the database password.
- New event-log type **`contact_sync`** (additive only, per
  the standing audit rule): details carry user id, patient
  id, action (create/update/delete/error) — **never** names,
  phone numbers, or addresses.

## 5. What syncs — the rules

- **Population:** for clinician U, the book contains exactly
  the patients with a live link (`patient_links`,
  `removed_at IS NULL`) whose **list_status = 'active'**.
  On-hold and discharged patients are NOT in the book. No
  link → no contact. Admins sync their own list like anyone
  else (no platform-wide book in v1).
- **Direction: one-way, CareTask → phone.** CareTask is the
  system of record. The phone account is **read-only** (rights
  file), so the Contacts app can't push edits back or create
  stray contacts in the book; anything typed on the phone
  outside CareTask simply isn't part of this list. (Two-way
  sync is an explicit non-goal for v1 — see §11.)
- **Field minimization** — only directory fields ever leave
  the API:

  | vCard field | Source | Notes |
  |---|---|---|
  | FN / N | fname, lname (+ mname) | display + structured name |
  | TEL TYPE=CELL | phone_cell | omitted if empty |
  | TEL TYPE=HOME | phone_home | omitted if empty |
  | EMAIL | email | omitted if empty |
  | ADR | street, street_line_2, city, state, postal_code, country_code | omitted if no street |
  | UID | patient UUID | stable identity — updates never duplicate |
  | REV | last sync time | |

  **Never sent:** date of birth, notes, zone, flags, status,
  SSN / driver's license, billing, pharmacy, emergency
  contacts, agency, clinician notes — nothing clinical.
- **Updates:** when a synced field changes on the patient, or
  a link's status changes, the contact is re-PUT (with
  `If-Match` on the stored etag; on 412, re-read and overwrite
  — CareTask wins, it is the record).
- **Removals:** list_status → hold/discharged, link removed,
  or patient soft-deleted ⇒ the vCard is DELETEd from that
  clinician's book (other clinicians' books are unaffected).
  Deleting the contact on the server removes it from the
  phone on its next sync.
- **Merges:** the deploy-28 patient merge re-points links to
  the survivor; the loser's contact is deleted and the
  survivor's (re)synced by the normal reconcile.

## 6. vCard profile

- **vCard 3.0** (the version iOS CardDAV handles most
  reliably), UTF-8, CRLF, lines folded at 75 octets, text
  escaped per spec (\, \; \n). One contact per .vcf resource,
  filename = patient UUID.
- `PRODID:-//Marc Innotech//CareTask//EN`.
- No photo, no notes field, no custom X- properties in v1 —
  the patient UUID in the UID is the only key we need.

## 7. Sync engine

- **On-change:** patient create/update, link create/status
  change/remove, and merge enqueue a per-clinician sync job
  (in-process queue, same pattern as the rest of the API —
  no new infrastructure). Jobs are idempotent: a job is just
  "reconcile clinician U's book."
- **Reconcile:** compute the desired set (active links →
  canonical vCards + content hashes); read the book's current
  state in one PROPFIND (href + etag); diff against
  `contact_sync_items`: PUT new/changed, DELETE vanished,
  skip unchanged. A full reconcile for one clinician is
  bounded by their list size (tens, not thousands).
- **Periodic safety net:** a full reconcile per enabled
  clinician every hour (in-process timer), plus a **Sync
  now** button in Settings. This self-heals anything the
  on-change path missed (crashes, manual DB edits).
- **Failures never block clinical work.** A failed sync marks
  `last_result`, writes a `contact_sync` error event, and is
  retried by the next job / hourly pass. Settings shows the
  last sync time and result to the clinician.

## 8. Provisioning & the clinician experience

CareTask Settings gains a **Phone contacts** card:

1. **Enable sync** → the API creates the Radicale principal,
   the **CareTask** address book, and a random 20+ character
   password; the card shows server / username / password
   **once**, with a **Regenerate password** button (invalidates
   the old one) for later.
2. **iPhone steps** printed in the card (iOS 18 wording, from
   Apple's own guide): Settings → Apps → Contacts → Contacts
   Accounts → Add Account → Other → **Add CardDAV Account** →
   server `contacts.marcinnotech.net`, the username and
   password shown, description **CareTask**. Then Contacts →
   Lists shows the **CareTask** list.
3. **Sync now** button + last-synced line ("Synced 12:04 PM
   · 23 contacts").
4. **Disable** → book and htpasswd entry are removed; the
   contacts disappear from the phone with the account (and
   immediately server-side).

Android note (no extra build): DAVx5 with the same server /
username / password gives the same list.

## 9. Security & privacy

- HTTPS only (Caddy automatic TLS); Radicale itself never
  exposed except through Caddy on localhost binding.
- Per-clinician random passwords (bcrypt in htpasswd);
  clinician rights are **read-only and own-book only**; the
  write-capable `ctsync` credential exists only in the API
  `.env`. A leaked phone password exposes one clinician's
  directory fields (name/phone/address) — and is revocable in
  one click — it cannot write, and cannot see any other book.
- Sync payloads are the minimized field set of §5; sync logs
  and events carry ids only.
- The Radicale storage directory joins the VM backup routine
  (it is fully rebuildable from CareTask by a reconcile, so
  backup is belt-and-braces).
- Staff deactivation (users.active = false) disables their
  sync and removes their book on the next reconcile pass.

## 10. Testing plan

- **Unit:** vCard builder (escaping, folding, field omission,
  hash stability); reconcile diff (create/update/delete/skip
  cases).
- **Local integration:** Radicale in a scratch venv + scratch
  Postgres: enable → book exists with the right name; status
  flips add/remove contacts; merge re-points; disable tears
  down; wrong-password and read-only-write attempts fail.
- **Device check (Jake's iPhone):** add the account, confirm
  the **CareTask** list appears, an incoming call from a test
  patient number shows the name, discharge a test patient and
  watch it leave the list. This device check is part of done —
  it cannot be verified from the server side alone.

## 11. Non-goals (v1)

- Two-way sync (phone edits flowing back into CareTask).
- iCloud / Google as sync targets (Google: BAA, §2; iCloud
  has no third-party write API).
- Staff contacts in the book (patients only; staff directory
  sync is a separate, easier question if ever wanted).
- Photos, favorites, groups-within-the-book, per-agency books.
- CalDAV (the same Radicale could carry calendars later —
  explicitly out of scope here).

## 12. Build phases (when authorized)

1. **Server:** install Radicale on the VM (systemd), config +
   rights + htpasswd, Caddy site + Cloudflare DNS record,
   smoke-test with curl and a throwaway account.
2. **API:** schema, contact-sync module (DAV client, vCard
   builder, reconcile), provisioning endpoints, Settings API,
   event type, test suites.
3. **Dashboard:** Phone contacts Settings card (enable,
   one-time credential display, Sync now, disable) + Help
   Center entry with the iPhone steps.
4. **Pilot:** Jake enables it, iPhone device check per §10,
   then decide on clinician rollout.

## 13. Open decisions for Jake (defaults chosen in this spec)

1. **One-way + read-only phone account** (§5) — recommended;
   the alternative (writable / two-way) risks un-audited
   changes to the record and is deferred to v2 if ever.
2. **Address included** in the synced fields (§5) — useful for
   tap-to-navigate from Contacts; can be dropped to
   name + phones + email only if you prefer a thinner list.
3. **Hourly reconcile + on-change + Sync now** (§7) —
   changes typically land on the phone within a minute via
   on-change; the hourly pass is only a safety net.
4. **Subdomain `contacts.marcinnotech.net`** (§3) — any other
   name works the same; this one reads clearly in the iPhone
   account list.
