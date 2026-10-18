// The 9 brief fields, in the order the interviewer should prioritise them.
export const FIELDS = [
  { id: "current_situation", label: "What is happening today", needsNumber: false },
  { id: "who_is_affected", label: "Who experiences it", needsNumber: false },
  { id: "why_it_matters", label: "Why it matters / cost of the problem", needsNumber: true },
  { id: "frequency_scale", label: "How often / how much", needsNumber: true },
  { id: "current_workaround", label: "How it is solved today", needsNumber: false },
  { id: "already_tried", label: "What has been tried", needsNumber: false },
  { id: "constraints", label: "Constraints (budget, tools, people, rules)", needsNumber: false },
  { id: "success_looks_like", label: "What a useful outcome looks like", needsNumber: false },
  { id: "confidential", label: "What must stay confidential", needsNumber: false },
] as const;

export type FieldId = (typeof FIELDS)[number]["id"];
export const FIELD_IDS = FIELDS.map((f) => f.id) as [FieldId, ...FieldId[]];

export function fieldMeta(id: string) {
  const f = FIELDS.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown field_id "${id}". Valid: ${FIELD_IDS.join(", ")}`);
  return f;
}

export type FieldStatus = "gap" | "vague" | "known" | "unknown" | "declined";
export type FactKind = "observation" | "claim" | "assumption";

export type FieldRow = {
  session_id: string;
  field_id: FieldId;
  label: string;
  status: FieldStatus;
  value: string | null;
  kind: FactKind | null;
  source: "user" | "website" | null;
  evidence_quote: string | null;
  confidence: number | null;
  sensitive: boolean;
  redaction: string | null; // JSON: [{item, replacement}]
  redaction_accepted: boolean | null;
  asked_count: number;
  updated_revision: number;
};

export function completeness(fields: Pick<FieldRow, "status">[]) {
  const score = fields.reduce((s, f) => {
    if (f.status === "known") return s + 1;
    if (f.status === "gap") return s;
    return s + 0.5; // vague, unknown, declined: addressed but not solid
  }, 0);
  return Math.round((score / FIELDS.length) * 100);
}
