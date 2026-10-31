// Clinical document templates for the CareTask demo API —
// the three PT document types in v1, modeled on OpenEMR's
// encounter forms: a document type is a fixed set of named
// sections, and the document's `sections` JSONB holds one string
// per section key (draft notes today, structured content later).
//
// The template is the source of truth for which section keys are
// valid for a doc_type: routes validate incoming sections against
// it (unknown key or non-string value → 400 VALIDATION), and new
// documents are seeded with every template key present (empty
// string) so the dashboard can render the full form without
// guessing which keys exist.

const DOCUMENT_TEMPLATES = {
  evaluation: {
    label: 'Evaluation',
    defaultTitle: 'Physical Therapy Evaluation',
    sections: [
      { key: 'subjective', label: 'Subjective / History of Present Illness' },
      { key: 'objective', label: 'Objective — Vitals, ROM, Strength, Balance, Functional Mobility' },
      { key: 'assessment', label: 'Assessment' },
      { key: 'plan_of_care', label: 'Plan of Care — Goals, Frequency, Interventions' },
    ],
  },
  reassessment: {
    label: 'Reassessment',
    defaultTitle: 'Physical Therapy Reassessment',
    sections: [
      { key: 'interval_history', label: 'Interval History' },
      { key: 'objective', label: 'Objective Re-measures' },
      { key: 'progress_toward_goals', label: 'Progress Toward Goals' },
      { key: 'assessment', label: 'Assessment' },
      { key: 'updated_plan', label: 'Updated Plan' },
    ],
  },
  discharge: {
    label: 'Discharge',
    defaultTitle: 'Physical Therapy Discharge Summary',
    sections: [
      { key: 'summary_of_care', label: 'Summary of Care' },
      { key: 'episode_summary', label: 'Visits / Episode Summary' },
      { key: 'final_status', label: 'Final Status & Outcomes' },
      { key: 'home_exercise_program', label: 'Home Exercise Program' },
      { key: 'discharge_reason', label: 'Reason for Discharge' },
      { key: 'follow_up', label: 'Follow-up Recommendations' },
    ],
  },
};

const DOC_TYPES = Object.keys(DOCUMENT_TEMPLATES);

function validationError(message) {
  const e = new Error(message);
  e.status = 400;
  e.code = 'VALIDATION';
  return e;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Validate a sections payload for a doc_type. undefined/null is
// treated as {} (no sections supplied). Every key must belong to
// the template for that doc_type and every value must be a string.
// Returns the (validated) plain object. Throws an Error with
// .status=400 and .code='VALIDATION' otherwise.
function validateSections(docType, sections) {
  const template = DOCUMENT_TEMPLATES[docType];
  if (!template) {
    throw validationError(`unknown doc_type: ${docType}`);
  }
  if (sections === undefined || sections === null) return {};
  if (!isPlainObject(sections)) {
    throw validationError('sections must be an object');
  }
  const allowed = new Set(template.sections.map((s) => s.key));
  for (const [key, value] of Object.entries(sections)) {
    if (!allowed.has(key)) {
      throw validationError(`unknown section for ${docType}: ${key}`);
    }
    if (typeof value !== 'string') {
      throw validationError(`section ${key} must be a string`);
    }
  }
  return sections;
}

// { key: "" } for every template key of the doc_type — the shape a
// new document starts from before supplied sections are merged over.
function emptySections(docType) {
  const template = DOCUMENT_TEMPLATES[docType];
  if (!template) {
    throw validationError(`unknown doc_type: ${docType}`);
  }
  const out = {};
  for (const s of template.sections) out[s.key] = '';
  return out;
}

module.exports = { DOCUMENT_TEMPLATES, DOC_TYPES, validateSections, emptySections };
