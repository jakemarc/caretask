// Seed the users table with demo staff (CareTask demo API).
//
// Includes:
// - Jake's two sign-in accounts as admin / manager, both with the
//   DEMO manager PIN 1234 (stored only as a scrypt hash). These are
//   the accounts that can actually sign in to the demo, so the PIN
//   override is testable end to end. Change the PIN by updating
//   pin_hash with lib/pin.js hashPin() — never by hand-editing SQL
//   with a plaintext value.
// - Three fictional staff (.example emails, 555 phones) showing the
//   non-manager shapes: an assignable clinician (authorized), a
//   front-office user, and a developer (both authorized = false).
//
// Re-running is safe (upsert by email) and RESETS the demo PINs to
// 1234 — this is a demo seed, not a user-management tool.
//
// Run:  PGDATABASE=caretask_demo node seed-users.js
const pool = require('./db');
const { hashPin } = require('./lib/pin');

const DEMO_MANAGER_PIN = '1234';

const STAFF = [
  {
    email: 'jakemarc@gmail.com',
    role: 'admin',
    authorized: true,
    fname: 'Jake',
    lname: 'Marc',
    valedictory: 'PT',
    pin: DEMO_MANAGER_PIN,
  },
  {
    email: 'jakemarc2@gmail.com',
    role: 'manager',
    authorized: true,
    fname: 'Jake',
    lname: 'Marc',
    valedictory: 'PT',
    pin: DEMO_MANAGER_PIN,
  },
  {
    email: 'maria.santos@example.com',
    role: 'clinician',
    authorized: true,
    fname: 'Maria',
    lname: 'Santos',
    valedictory: 'PT, DPT',
    specialty: 'Physical Therapy',
    npi: '1000000001',
    phone: '(555) 014-2001',
    phonecell: '(555) 014-2002',
  },
  {
    email: 'dana.whitfield@example.com',
    role: 'front_office',
    authorized: false,
    fname: 'Dana',
    lname: 'Whitfield',
    phone: '(555) 014-2003',
  },
  {
    email: 'chris.novak@example.com',
    role: 'developer',
    authorized: false,
    fname: 'Chris',
    lname: 'Novak',
    notes: 'System maintenance — no patient assignment.',
  },
];

async function main() {
  for (const s of STAFF) {
    const pinHash = s.pin ? await hashPin(s.pin) : null;
    await pool.query(
      `INSERT INTO users (email, role, authorized, fname, lname, valedictory,
                          specialty, npi, phone, phonecell, notes, pin_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (email) DO UPDATE SET
         role = EXCLUDED.role,
         authorized = EXCLUDED.authorized,
         fname = EXCLUDED.fname,
         lname = EXCLUDED.lname,
         valedictory = EXCLUDED.valedictory,
         specialty = EXCLUDED.specialty,
         npi = EXCLUDED.npi,
         phone = EXCLUDED.phone,
         phonecell = EXCLUDED.phonecell,
         notes = EXCLUDED.notes,
         pin_hash = EXCLUDED.pin_hash`,
      [
        s.email, s.role, s.authorized, s.fname, s.lname,
        s.valedictory ?? null, s.specialty ?? null, s.npi ?? null,
        s.phone ?? null, s.phonecell ?? null, s.notes ?? null, pinHash,
      ],
    );
    console.log(`seeded user ${s.email} (${s.role})`);
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error('seed-users failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
