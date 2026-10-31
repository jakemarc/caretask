// Seed for the appointment reference lists — categories and
// statuses, correlated with OpenEMR's defaults (see
// schema-appointments.sql header). Idempotent (ON CONFLICT upserts);
// safe to re-run:
//   node seed-appointment-lists.js
const pool = require('./db');

const CATEGORIES = [
  // [name, color, cattype, default_duration_min, description]
  ['Initial Evaluation', '#0d9488', 'appointment', 60, 'First visit: evaluation and plan of care'],
  ['Start of Care', '#059669', 'appointment', 90, 'Start of care: comprehensive assessment and admission visit'],
  ['Resumption of Care', '#0891b2', 'appointment', 60, 'Resumption of care after an inpatient stay'],
  ['Revisit', '#2563eb', 'appointment', 45, 'Regular treatment session'],
  ['Reassessment', '#d97706', 'appointment', 60, 'Reassessment visit'],
  ['Transfer', '#e11d48', 'appointment', 30, 'Transfer (to inpatient facility) visit/documentation'],
  ['Discipline Discharge', '#7c3aed', 'appointment', 45, 'Discharge of one discipline; other disciplines continue'],
  ['Admin Discharge', '#78716c', 'appointment', 30, 'Administrative discharge (moved, unable to serve, policy reasons)'],
  ['OASIS Discharge', '#6d28d9', 'appointment', 60, 'Full agency discharge with the OASIS discharge assessment'],
  ['In Office', '#16a34a', 'provider', 480, 'Provider is in (schedule block)'],
  ['Out of Office', '#64748b', 'provider', 480, 'Provider is out (schedule block)'],
  ['Lunch', '#f59e0b', 'provider', 60, 'Lunch break'],
  ['Vacation', '#ec4899', 'provider', 480, 'Vacation / day off'],
];

const STATUSES = [
  // [code, label, color, is_checkin, is_checkout, sort_order]
  ['booked', 'Booked', '#2563eb', false, false, 1],
  ['confirmed', 'Confirmed', '#0891b2', false, false, 2],
  ['arrived', 'Arrived', '#16a34a', true, false, 3],
  ['in_room', 'In Room', '#d97706', false, false, 4],
  ['checked_out', 'Checked Out', '#7c3aed', false, true, 5],
  ['cancelled', 'Cancelled', '#dc2626', false, false, 6],
  ['no_show', 'No Show', '#475569', false, false, 7],
];

async function main() {
  for (const [name, color, cattype, dur, desc] of CATEGORIES) {
    await pool.query(
      `INSERT INTO appointment_categories (name, color, cattype, default_duration_min, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET
         color = EXCLUDED.color, cattype = EXCLUDED.cattype,
         default_duration_min = EXCLUDED.default_duration_min,
         description = EXCLUDED.description`,
      [name, color, cattype, dur, desc],
    );
  }
  for (const [code, label, color, ci, co, ord] of STATUSES) {
    await pool.query(
      `INSERT INTO appointment_statuses (code, label, color, is_checkin, is_checkout, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO UPDATE SET
         label = EXCLUDED.label, color = EXCLUDED.color,
         is_checkin = EXCLUDED.is_checkin, is_checkout = EXCLUDED.is_checkout,
         sort_order = EXCLUDED.sort_order`,
      [code, label, color, ci, co, ord],
    );
  }
  console.log(`seeded ${CATEGORIES.length} categories, ${STATUSES.length} statuses`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
