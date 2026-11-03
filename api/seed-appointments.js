// Demo appointments seed (CareTask calendar) — LOCAL/DEMO ONLY.
//
// Generates appointments RELATIVE TO TODAY for the fictional seed
// patients, using the seeded OpenEMR-correlated categories and
// statuses (run seed.js, seed-users.js, seed-appointment-lists.js
// first). Maria Santos (seed clinician) is the provider where one
// is assigned; the rest are unassigned.
//
// It REPLACES all existing appointments (TRUNCATE) — demo data only,
// run manually, never automatically:
//   node seed-appointments.js
// The TRUNCATE runs with CASCADE because documents.appointment_id
// references appointments — documents pointing at appointments are
// cleared along with them. Still demo-only, still manual.
const pool = require('./db');

const PLAN = [
  // [daysFromToday, hour, minute, lname|null, category, status, provider?]
  [-6, 9, 0, 'Sharma', 'Revisit', 'no_show', true],
  [-2, 10, 0, 'Bennett', 'Reassessment', 'checked_out', true],
  [0, 8, 30, 'Delgado', 'Revisit', 'checked_out', true],
  [0, 11, 0, 'Keller', 'Revisit', 'arrived', true],
  [0, 14, 0, 'Lin', 'Reassessment', 'booked', false],
  [1, 9, 0, 'Reyes', 'Initial Evaluation', 'confirmed', true],
  [1, 13, 30, 'Turner', 'Start of Care', 'booked', false],
  [2, 10, 15, 'Walker', 'Revisit', 'cancelled', true],
  [2, 15, 0, 'Delgado', 'Reassessment', 'booked', false],
  [3, 9, 30, 'Sharma', 'Resumption of Care', 'booked', true],
  [4, 11, 0, 'Bennett', 'Revisit', 'booked', false],
  [5, 10, 0, 'Turner', 'Transfer', 'booked', true],
  [7, 9, 0, 'Keller', 'Initial Evaluation', 'booked', true],
  [8, 13, 0, 'Lin', 'OASIS Discharge', 'booked', false],
  // One provider schedule block (no patient), the OpenEMR way.
  [1, 12, 0, null, 'Lunch', 'booked', true],
];

function at(days, h, m) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d;
}

async function main() {
  const patients = await pool.query(
    'SELECT id, lname FROM patients WHERE deleted_at IS NULL',
  );
  const byLname = new Map(patients.rows.map((p) => [p.lname, p.id]));
  const cats = await pool.query(
    'SELECT id, name, default_duration_min FROM appointment_categories',
  );
  const byCat = new Map(cats.rows.map((c) => [c.name, c]));
  const prov = await pool.query(
    "SELECT id FROM users WHERE email = 'maria.santos@example.com'",
  );
  const providerId = prov.rows[0]?.id ?? null;

  await pool.query('TRUNCATE appointments RESTART IDENTITY CASCADE');
  let made = 0;
  for (const [days, h, m, lname, catName, status, withProvider] of PLAN) {
    const cat = byCat.get(catName);
    if (!cat) continue;
    const pid = lname ? byLname.get(lname) : null;
    if (lname && !pid) continue;
    const start = at(days, h, m);
    const end = new Date(start.getTime() + cat.default_duration_min * 60000);
    await pool.query(
      `INSERT INTO appointments (patient_id, provider_id, category_id, title, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        pid,
        withProvider ? providerId : null,
        cat.id,
        catName,
        start.toISOString(),
        end.toISOString(),
        status,
      ],
    );
    made += 1;
  }
  console.log(`seeded ${made} demo appointments`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
