"use client";
import type { Field } from "@/lib/client";

const STATUS: Record<Field["status"], { label: string; dot: string; card: string }> = {
  gap: { label: "Missing", dot: "bg-red-500", card: "border-red-200 bg-red-50/40" },
  vague: { label: "Needs detail", dot: "bg-amber-500", card: "border-amber-200 bg-amber-50/50" },
  known: { label: "Captured", dot: "bg-emerald-500", card: "border-emerald-200 bg-white" },
  unknown: { label: "Unknown", dot: "bg-stone-400", card: "border-stone-200 bg-stone-50" },
  declined: { label: "Declined", dot: "bg-stone-400", card: "border-stone-200 bg-stone-50" },
};

const KIND: Record<string, string> = {
  observation: "bg-emerald-100 text-emerald-800",
  claim: "bg-sky-100 text-sky-800",
  assumption: "bg-violet-100 text-violet-800",
};

export function BriefPanel({
  fields,
  cursor,
  completeness,
  revision,
}: {
  fields: Field[];
  cursor: string | null;
  completeness: number;
  revision: number;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-stone-200 px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold text-stone-900">Live brief</h2>
          <span className="text-xs text-stone-500">revision {revision}</span>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-200">
            <div className="h-full rounded-full bg-teal-600 transition-all duration-500" style={{ width: `${completeness}%` }} />
          </div>
          <span className="text-sm font-medium tabular-nums text-stone-700">{completeness}%</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-stone-500">
          {(["known", "vague", "gap", "unknown"] as const).map((s) => (
            <span key={s} className="flex items-center gap-1">
              <span className={`h-2 w-2 rounded-full ${STATUS[s].dot}`} />
              {STATUS[s].label}
            </span>
          ))}
        </div>
      </div>
      <ul className="flex-1 space-y-2 overflow-y-auto p-3">
        {fields.map((f) => {
          const st = STATUS[f.status];
          const asking = f.field_id === cursor;
          return (
            <li
              key={f.field_id}
              className={`rounded-xl border p-3 transition ${st.card} ${asking ? "ring-2 ring-teal-600" : ""}`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${st.dot}`} />
                <span className="text-sm font-medium text-stone-900">{f.label}</span>
                {f.sensitive && (
                  <span title="Contains sensitive info — will be redacted in the public brief" className="text-xs">
                    🔒
                  </span>
                )}
                <span className="ml-auto flex gap-1">
                  {asking && <span className="rounded bg-teal-700 px-1.5 py-0.5 text-[10px] font-medium text-white">asking now</span>}
                  {f.kind && <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${KIND[f.kind]}`}>{f.kind}</span>}
                  {f.source === "website" && (
                    <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[10px] font-medium text-stone-700">website</span>
                  )}
                </span>
              </div>
              {f.value ? (
                <p className="mt-1.5 text-sm text-stone-700">{f.value}</p>
              ) : (
                <p className="mt-1.5 text-sm italic text-stone-400">{st.label}</p>
              )}
              {f.evidence_quote && f.value && (
                <p className="mt-1 line-clamp-2 text-xs text-stone-500" title={f.evidence_quote}>
                  “{f.evidence_quote}”
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
