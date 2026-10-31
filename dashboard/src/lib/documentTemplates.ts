// Clinical document templates for CareTask.
//
// Mirrors the API's lib/documentTemplates.js EXACTLY (same types,
// labels, default titles, and section keys/labels) — the dashboard
// renders one textarea per section, and the API validates section
// keys against the same definitions.

export type DocType = "evaluation" | "reassessment" | "discharge";

export interface DocTemplateSection {
  key: string;
  label: string;
}

export interface DocTemplate {
  type: DocType;
  label: string;
  defaultTitle: string;
  sections: DocTemplateSection[];
}

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    type: "evaluation",
    label: "Evaluation",
    defaultTitle: "Physical Therapy Evaluation",
    sections: [
      { key: "subjective", label: "Subjective / History of Present Illness" },
      {
        key: "objective",
        label:
          "Objective — Vitals, ROM, Strength, Balance, Functional Mobility",
      },
      { key: "assessment", label: "Assessment" },
      {
        key: "plan_of_care",
        label: "Plan of Care — Goals, Frequency, Interventions",
      },
    ],
  },
  {
    type: "reassessment",
    label: "Reassessment",
    defaultTitle: "Physical Therapy Reassessment",
    sections: [
      { key: "interval_history", label: "Interval History" },
      { key: "objective", label: "Objective Re-measures" },
      { key: "progress_toward_goals", label: "Progress Toward Goals" },
      { key: "assessment", label: "Assessment" },
      { key: "updated_plan", label: "Updated Plan" },
    ],
  },
  {
    type: "discharge",
    label: "Discharge",
    defaultTitle: "Physical Therapy Discharge Summary",
    sections: [
      { key: "summary_of_care", label: "Summary of Care" },
      { key: "episode_summary", label: "Visits / Episode Summary" },
      { key: "final_status", label: "Final Status & Outcomes" },
      { key: "home_exercise_program", label: "Home Exercise Program" },
      { key: "discharge_reason", label: "Reason for Discharge" },
      { key: "follow_up", label: "Follow-up Recommendations" },
    ],
  },
];

export function templateFor(type: DocType): DocTemplate {
  return DOC_TEMPLATES.find((t) => t.type === type) ?? DOC_TEMPLATES[0];
}

export function emptySections(
  template: DocTemplate,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const section of template.sections) out[section.key] = "";
  return out;
}
