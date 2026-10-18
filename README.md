# Intake: Problem Intake Agent

Voice AI Buildathon (Paytm × AI Garage, Bengaluru, 18 Oct 2026), **Challenge 2: Problem Intake Agent**.

> We help **a small business owner** turn **their website + a one-line pain point** into **a confirmed, redacted problem brief that builders can act on**.

## The loop

1. **Start:** the owner gives a website URL (optional) and one line about the problem.
2. **Organize:** Firecrawl reads the site; Gemini pre-fills only the fields the sources support, each with a verbatim evidence quote. Quotes that can't be found in the sources are dropped, so nothing is invented.
3. **Ask:** a text or **live voice** interview (Gemini Live) asks *only about gaps*, one short question at a time:
   - probes vague answers for a number, an example or a person;
   - marks "I don't know" as unknown and never re-asks it;
   - flags sensitive names and figures, and asks whether they can be made public;
   - replies in English, Hindi or Hinglish.
4. **Check:** on the review screen the owner corrects any field, accepts or rejects each redaction, then **approves one exact revision**. Any later edit invalidates the approval.
5. **Versions:** builder brief, public (redacted) brief and exec one-pager, all generated **only from the approved snapshot**.
6. **Share:** a separate confirmation dialog shows exactly what will be published. Cancel means nothing is shared.

## Design rules (from the workbook)

- **The backend (Neon Postgres) is the source of truth**, not the transcript. Refresh, disconnect or pause and you resume at the exact saved question (`cursor_field`).
- Text and voice drive the **same tool layer** (`POST /api/tool`). The voice agent calls tools from the browser using an ephemeral token. The Gemini key never leaves the server, and the prompt and tools are locked into the token.
- Every user decision carries a `decision_id`, so a double click or a repeated "confirm" is idempotent.
- State machine: `awaiting_input → organizing → interviewing ⇄ paused → drafting → reviewing → approved(rev N) → shared | cancelled`, with invalid transitions rejected.
- Every field carries: status (missing, needs detail, captured, unknown, declined); kind (observation, claim, assumption); and an evidence quote.

## Stack

Next.js 16 · Gemini (`gemini-3.8-flash` for text, `gemini-3.8-live` for voice) · Neon Postgres · Firecrawl · Vercel. No card needed for any of them.

## Run locally

```bash
npm install
```

Create `.env.local` with `GEMINI_API_KEY`, `GEMINI_TEXT_MODEL`, `GEMINI_LIVE_MODEL`, `FIRECRAWL_API_KEY` and `DATABASE_URL` (Neon, pooled). Then create the tables with the SQL in [`db/schema.sql`](db/schema.sql) and run:

```bash
npm run dev
```

## Test matrix (workbook section 09)

| Test | Result |
|---|---|
| Broken or private URL | ✅ Continues from the one-liner; the scrape error is recorded, no crash |
| Rambler (several problems at once) | ✅ Asks which one hurts most; the rest go under constraints *(fixed, see the log)* |
| Vague answer ("we lose a lot of sales") | ✅ Field turns amber; the agent asks for a number |
| One-word / "dunno" | ✅ Offers example ranges; "dunno" is marked unknown and never re-asked |
| Change an answer | ✅ Saved as a new revision with history; invalidates any approval |
| Pause and return / refresh | ✅ Same question reopens; chat history restored from the DB |
| "Confirm" twice | ✅ Idempotent `decision_id` replay; nothing skipped or doubled |
| Stale approval (approve rev 3 when current is 10) | ✅ Rejected |
| Share before approval or versions | ✅ Rejected |
| Final preview vs saved fields | ✅ Versions are built only from the approved snapshot |
| Cancel | ✅ Nothing shared; the public link says "not shared" |
| Prompt injection ("ignore your instructions…") | ✅ Stays on task |
| Asks for a solution | ✅ Notes it as an idea under already_tried and goes back to the problem |
| Mic blocked | ✅ Falls back to typing with a clear message |
| Voice drop | ✅ Auto-reconnects (up to 3×) with a fresh token built from DB state, then re-asks the current question |

## Failure log

| Unseen input | Failure | Root cause | Fix | Retest |
|---|---|---|---|---|
| Owner says "pata nahi" about a field that already had info | Field showed "Owner doesn't know" while still holding a value | `mark_unknown` overwrote the status regardless of the existing value | Keep it as "needs detail" when a value exists, and stop asking either way | ✅ |
| Owner lists 4 problems at once | Agent picked one silently | No rule for multiple problems | Rule: ask which one hurts most; note the rest under constraints | ✅ |
| "Yes, fine to name Practo" | Agent agreed, but the review still redacted it | The agent had no tool to record redaction consent mid-interview | Exposed `set_redaction` to the agent during the interview | ✅ |
| Typing while a turn was still finishing | Message vanished | Input cleared before checking the in-flight guard | Check the guard before clearing; one turn at a time | ✅ |
| Chat turns took 12–20 s | Too slow for a live demo | 3 LLM calls per turn plus heavy thinking | Single LLM call per turn (structured guidance instead of a generated question) and low thinking | ✅ |
| Deployed app: chat turns 10–12 s vs ~6 s locally | Sluggish demo | Vercel functions ran in the US; Neon DB is in Singapore, so every query crossed the Pacific | Pinned functions to `sin1` in `vercel.json` | ✅ ~5 s |

**Live demo:** https://intake-agent-lon5.vercel.app
