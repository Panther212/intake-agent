@AGENTS.md

# Problem Intake Agent (Voice AI Buildathon, Option B)

We help a small business owner turn their website + a one-line pain point into a
confirmed, redacted problem brief builders can act on.

## Non-negotiables (from the workbook)
- Backend (Neon Postgres) is the source of truth, never the transcript.
- Text chat must work end-to-end before voice. Voice reuses the SAME tools.
- Ask only for missing info. Never invent facts. Gaps stay visible.
- Every field editable; each edit bumps session.revision and writes field_history.
- Approval binds to one exact revision. Any later edit requires new approval.
- "Share" is a separate explicit confirmation after approval. Cancel = nothing shared.
- Every mutating call carries decision_id; repeated decision_id returns stored result (idempotent).
- Paused sessions resume at session.cursor_field.
- No secrets in code, logs or client. Gemini key only server-side; browser uses ephemeral token.

## Fields (field_id → label)
current_situation → What is happening today
who_is_affected → Who experiences it
current_workaround → How it is solved today
why_it_matters → Why it matters / cost of the problem
frequency_scale → How often / how much
constraints → Constraints (budget, tools, people, rules)
already_tried → What has been tried
confidential → What must stay confidential
success_looks_like → What a useful outcome looks like

## State machine
awaiting_input → organizing → interviewing ⇄ paused → drafting → reviewing
→ approved(rev N) → shared | cancelled

## Tools (POST /api/tool {name, session_id, decision_id?, args})
create_session(url, line) · organize(session_id) · get_next_question(session_id)
record_answer(field_id, value, kind, evidence_quote, confidence)
correct_answer(field_id, value) · mark_unknown(field_id) · decline(field_id)
flag_sensitive(field_id, item, suggested_redaction) · pause · resume
get_review · set_redaction(field_id, accepted) · approve_revision(revision)
generate_versions · confirm_share(revision) · cancel

## Interviewer style
One short question at a time. Reflect back briefly. Probe vague answers for a number,
example or person. Max 2 follow-ups per field. "I don't know" → mark_unknown, never re-ask.
Never give solutions; note ideas under already_tried. Reply in the user's language
(Hindi/Hinglish OK); brief always in English.

## Stack
Next.js 16 App Router (src/, cacheComponents on — route handlers are POST/dynamic), Tailwind 4,
@google/genai (models from env GEMINI_TEXT_MODEL, GEMINI_LIVE_MODEL),
@neondatabase/serverless (server only, DATABASE_URL), plain parameterised SQL, no ORM,
@mendable/firecrawl-js (FIRECRAWL_API_KEY), zod for every LLM JSON output.
Tables: sessions, fields, field_history, messages, decisions, briefs (created in Neon SQL editor).
