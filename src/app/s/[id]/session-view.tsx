"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { BriefPanel } from "@/components/brief-panel";
import { callTool, newDecisionId, type Message, type SessionState } from "@/lib/client";
import { useLiveVoice, type VoiceStatus } from "@/lib/use-live-voice";

const VOICE_LABEL: Record<VoiceStatus, string> = {
  idle: "",
  connecting: "Connecting…",
  listening: "Listening",
  speaking: "Agent speaking — talk any time to interrupt",
  reconnecting: "Reconnecting… your answers are saved",
  error: "Voice stopped",
};

type ToolEvent = { name: string; args?: { field_id?: string; item?: string }; ok: boolean };
type ChatItem = Message & { events?: ToolEvent[]; pending?: boolean };

const EVENT_LABEL: Record<string, string> = {
  record_answer: "Recorded",
  correct_answer: "Corrected",
  mark_unknown: "Marked unknown",
  decline: "Declined",
  flag_sensitive: "Flagged sensitive",
  set_redaction: "Redaction choice saved",
  pause: "Paused",
  resume: "Resumed",
  finish_interview: "Interview finished",
};

export default function SessionView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [state, setState] = useState<SessionState | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ msg: string; retry: string | null } | null>(null);
  const started = useRef(false);
  const busy = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const s = await callTool<SessionState>("get_session", id);
    setState(s);
    return s;
  }, [id]);

  const send = useCallback(
    async (text: string | null, isRetry = false) => {
      if (busy.current) return; // one turn at a time
      busy.current = true;
      setSending(true);
      setError(null);
      if (text && !isRetry) setChat((c) => [...c, { role: "user", channel: "text", content: text }]);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: id, message: text }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        const events = (json.events as ToolEvent[]).filter((e) => e.ok && EVENT_LABEL[e.name]);
        setChat((c) => [...c, { role: "agent", channel: "text", content: json.reply, events }]);
        const s = await load();
        if (s.status === "reviewing") router.push(`/s/${id}/review`);
      } catch (e) {
        setError({ msg: e instanceof Error ? e.message : String(e), retry: text });
      } finally {
        busy.current = false;
        setSending(false);
      }
    },
    [id, load, router],
  );

  // Initial load: restore history from the database; start the interview if it has no messages yet.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    load()
      .then((s) => {
        setChat(s.messages.filter((m) => m.role !== "system"));
        if (s.messages.length === 0 && s.status === "interviewing") send(null);
      })
      .catch((e) => setError({ msg: String(e.message ?? e), retry: null }));
  }, [load, send]);

  // Poll so the panel stays live (voice turns will update it from elsewhere).
  useEffect(() => {
    const t = setInterval(() => load().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat, sending]);

  const voice = useLiveVoice({
    sessionId: id,
    onChange: () => void load().catch(() => {}),
    onTranscript: (role, text) => setChat((c) => [...c, { role, channel: "voice", content: text }]),
    onEnded: async () => {
      const s = await load();
      if (s.status === "reviewing") router.push(`/s/${id}/review`);
    },
  });
  const voiceOn = voice.status !== "idle" && voice.status !== "error";

  async function pause() {
    if (voiceOn) voice.stop();
    await callTool("pause", id, {}, newDecisionId());
    setChat((c) => [...c, { role: "agent", channel: "text", content: "Paused. Come back to this same link any time — I'll pick up exactly where we left off." }]);
    await load();
  }

  async function resume() {
    await callTool("resume", id, {}, newDecisionId());
    await load();
    send(null);
  }

  async function finish() {
    if (!confirm("Finish the interview and review the brief?")) return;
    if (voiceOn) voice.stop();
    await callTool("finish_interview", id, {}, newDecisionId());
    router.push(`/s/${id}/review`);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending || busy.current) return;
    setInput("");
    send(text);
  }

  if (!state) {
    return <div className="p-8 text-stone-500">{error ? `Could not load this session: ${error.msg}` : "Loading interview…"}</div>;
  }

  const live = state.status === "interviewing";
  const paused = state.status === "paused";

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-4 py-3">
        <Link href="/" className="text-sm font-semibold text-teal-700">
          Intake
        </Link>
        <p className="min-w-0 flex-1 truncate text-sm text-stone-600" title={state.input_line ?? ""}>
          {state.input_line}
        </p>
        <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-700">{state.status}</span>
        {live && (
          <button onClick={pause} className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-50">
            Pause
          </button>
        )}
        {(live || paused) && (
          <button onClick={finish} className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800">
            Finish & review
          </button>
        )}
        {!live && !paused && (
          <Link href={`/s/${id}/review`} className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white">
            Open review
          </Link>
        )}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_420px]">
        <section className="flex min-h-0 flex-col bg-stone-50">
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {chat.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[80%]">
                  {m.channel === "voice" && (
                    <p className={`mb-0.5 text-[11px] text-stone-400 ${m.role === "user" ? "text-right" : ""}`}>🎙 voice</p>
                  )}
                  <div
                    className={`whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${
                      m.role === "user" ? "bg-teal-700 text-white" : "border border-stone-200 bg-white text-stone-800"
                    }`}
                  >
                    {m.content}
                  </div>
                  {m.events && m.events.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {m.events.map((e, j) => (
                        <span key={j} className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] text-stone-700">
                          {EVENT_LABEL[e.name]}
                          {e.args?.field_id ? ` · ${e.args.field_id.replaceAll("_", " ")}` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-stone-200 bg-white px-4 py-2.5 text-stone-400">thinking…</div>
              </div>
            )}
            {voice.error && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{voice.error}</div>}
            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error.msg}{" "}
                <button className="font-medium underline" onClick={() => send(error.retry, true)}>
                  Retry
                </button>
              </div>
            )}
            <div ref={bottom} />
          </div>

          {paused ? (
            <div className="flex items-center justify-between gap-3 border-t border-stone-200 bg-amber-50 px-4 py-3">
              <span className="text-sm text-amber-900">Interview paused. Your answers are saved.</span>
              <button onClick={resume} className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white">
                Resume
              </button>
            </div>
          ) : live && voiceOn ? (
            <div className="flex items-center gap-3 border-t border-stone-200 bg-teal-50 px-4 py-3">
              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center">
                <span
                  className="absolute inset-0 rounded-full bg-teal-600/25 transition-transform duration-100"
                  style={{ transform: `scale(${1 + (voice.muted ? 0 : voice.level) * 0.9})` }}
                />
                <span className={`relative h-4 w-4 rounded-full ${voice.status === "speaking" ? "bg-teal-500" : "bg-teal-700"}`} />
              </div>
              <span className="flex-1 text-sm font-medium text-teal-900">
                {voice.muted ? "Muted" : VOICE_LABEL[voice.status]}
              </span>
              <button onClick={voice.toggleMute} className="rounded-lg border border-teal-700/30 bg-white px-3 py-1.5 text-sm">
                {voice.muted ? "Unmute" : "Mute"}
              </button>
              <button onClick={voice.stop} className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white">
                Switch to typing
              </button>
            </div>
          ) : live ? (
            <form onSubmit={submit} className="flex gap-2 border-t border-stone-200 bg-white px-4 py-3">
              <button
                type="button"
                onClick={voice.start}
                disabled={sending}
                title="Talk instead of typing"
                className="rounded-lg border border-teal-700 px-3 py-2 text-sm font-medium text-teal-800 hover:bg-teal-50 disabled:opacity-50"
              >
                🎙 Talk
              </button>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type your answer… (English, Hindi or Hinglish)"
                className="flex-1 rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
                autoFocus
              />
              <button
                disabled={sending || !input.trim()}
                className="rounded-lg bg-teal-700 px-4 py-2 font-medium text-white disabled:opacity-50"
              >
                Send
              </button>
            </form>
          ) : (
            <div className="border-t border-stone-200 bg-white px-4 py-3 text-sm text-stone-600">
              The interview is {state.status}. Continue on the review screen.
            </div>
          )}
        </section>

        <aside className="hidden min-h-0 border-l border-stone-200 bg-white lg:block">
          <BriefPanel fields={state.fields} cursor={state.cursor_field} completeness={state.completeness_pct} revision={state.revision} />
        </aside>
      </div>
    </div>
  );
}
