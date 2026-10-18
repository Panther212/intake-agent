"use client";
import { nanoid } from "nanoid";

export type Field = {
  field_id: string;
  label: string;
  status: "gap" | "vague" | "known" | "unknown" | "declined";
  value: string | null;
  kind: "observation" | "claim" | "assumption" | null;
  source: "user" | "website" | null;
  evidence_quote: string | null;
  sensitive: boolean;
  redaction: string | null;
  redaction_accepted: boolean | null;
  asked_count: number;
};

export type Message = { role: "user" | "agent" | "system"; channel: "text" | "voice"; content: string };

export type SessionState = {
  session_id: string;
  status: string;
  revision: number;
  approved_revision: number | null;
  cursor_field: string | null;
  input_url: string | null;
  input_line: string | null;
  completeness_pct: number;
  fields: Field[];
  messages: Message[];
};

/** Calls a backend tool. Pass decide=true for user decisions so double-clicks are idempotent. */
export async function callTool<T = unknown>(name: string, sessionId: string | null, args: object = {}, decisionId?: string) {
  const res = await fetch("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, session_id: sessionId, args, decision_id: decisionId }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? "Request failed");
  return json.result as T;
}

export const newDecisionId = () => nanoid();
