// Helpers for the central event_log (see schema-events.sql).
//
// Vocabulary — two groups, enforced separately:
// - CLIENT_EVENTS: the only events a signed-in dashboard may report
//   through POST /events (sign_in, sign_out, report_export). These are
//   things only the client observes: Firebase owns the actual login,
//   and the report PDF is generated on-device.
// - SERVER_EVENTS: written by the API itself (patient_view,
//   auth_failure, api_request, admin_action, appointment_change,
//   message_send, message_read, document_create, document_update,
//   document_finalize). POST /events rejects these, so a client
//   can never forge a server-side event.
const CLIENT_EVENTS = ['sign_in', 'sign_out', 'report_export'];
const SERVER_EVENTS = ['patient_view', 'auth_failure', 'api_request', 'admin_action', 'appointment_change', 'message_send', 'message_read', 'document_create', 'document_update', 'document_finalize', 'agency_sync', 'expense_change'];
const ALL_EVENTS = [...CLIENT_EVENTS, ...SERVER_EVENTS];

// Insert one event_log row. `db` is a pool or a transaction client.
// The chain trigger fills prev_hash/row_hash; this function never
// sets them. Never pass tokens, passwords, or request bodies in
// `details` — the request logger below records method/path/status
// only, on purpose.
async function insertEvent(db, { actor, event, patientId = null, details = {}, ip = null }) {
  const result = await db.query(
    `INSERT INTO event_log (actor_uid, actor_email, event, patient_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      actor.uid,
      actor.email,
      event,
      patientId,
      JSON.stringify(details),
      ip,
    ],
  );
  return result.rows[0];
}

module.exports = { CLIENT_EVENTS, SERVER_EVENTS, ALL_EVENTS, insertEvent };
