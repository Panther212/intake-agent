"use client";
import { GoogleGenAI, type LiveServerMessage, type Session } from "@google/genai";
import { useCallback, useEffect, useRef, useState } from "react";
import { callTool } from "./client";

export type VoiceStatus = "idle" | "connecting" | "listening" | "speaking" | "reconnecting" | "error";

type Options = {
  sessionId: string;
  /** Called after any tool runs or a transcript is saved, so the page can refresh the brief. */
  onChange: () => void;
  /** Called with each finished transcript line so the chat shows it live. */
  onTranscript: (role: "user" | "agent", text: string) => void;
  /** The agent ended or paused the interview. */
  onEnded: (status: string) => void;
};

const AGENT_TOOLS = new Set([
  "get_next_question",
  "record_answer",
  "correct_answer",
  "mark_unknown",
  "decline",
  "flag_sensitive",
  "set_redaction",
  "pause",
  "resume",
  "finish_interview",
]);
const SILENCE_MS = 10000;
const MAX_RECONNECTS = 3;

function toBase64(buf: ArrayBuffer) {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function pcm16ToFloat(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}

export function useLiveVoice({ sessionId, onChange, onTranscript, onEnded }: Options) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);

  const session = useRef<Session | null>(null);
  const wanted = useRef(false); // user wants voice on (distinguishes drops from hang-ups)
  const reconnects = useRef(0);
  const mic = useRef<{ stream: MediaStream; ctx: AudioContext; node: AudioWorkletNode } | null>(null);
  const out = useRef<{ ctx: AudioContext; nextAt: number; sources: Set<AudioBufferSourceNode> } | null>(null);
  const userBuf = useRef("");
  const agentBuf = useRef("");
  const silence = useRef<{ timer: ReturnType<typeof setTimeout> | null; nudges: number }>({ timer: null, nudges: 0 });
  const mutedRef = useRef(false);
  const stopRef = useRef<() => void>(() => {});
  const cb = useRef({ onChange, onTranscript, onEnded });
  useEffect(() => {
    cb.current = { onChange, onTranscript, onEnded };
  });

  // ---- transcripts: buffer partial transcription, save each finished line to the backend ----
  const flush = useCallback(
    async (role: "user" | "agent") => {
      const buf = role === "user" ? userBuf : agentBuf;
      const text = buf.current.replace(/\s+/g, " ").trim();
      buf.current = "";
      if (!text) return;
      cb.current.onTranscript(role, text);
      await callTool("log_message", sessionId, { role, channel: "voice", content: text }).catch(() => {});
    },
    [sessionId],
  );

  // ---- silence nudges: after the agent finishes, if nobody speaks for 10 s, check in (max twice) ----
  const clearSilence = () => {
    if (silence.current.timer) clearTimeout(silence.current.timer);
    silence.current.timer = null;
  };
  const armSilence = useCallback(() => {
    clearSilence();
    silence.current.timer = setTimeout(() => {
      const s = session.current;
      if (!s || mutedRef.current) return;
      silence.current.nudges += 1;
      const text =
        silence.current.nudges === 1
          ? "(The owner has been silent for a while. Gently check in once: offer to rephrase the question or give examples.)"
          : "(Still silent. Offer to pause the interview so they can come back later. If they agree, call pause.)";
      if (silence.current.nudges <= 2) s.sendRealtimeInput({ text });
    }, SILENCE_MS);
  }, []);

  // ---- audio playback (24 kHz PCM from the model), flushable on interruption ----
  const play = (b64: string) => {
    if (!out.current) return;
    const { ctx } = out.current;
    const samples = pcm16ToFloat(b64);
    const buffer = ctx.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, out.current.nextAt);
    src.start(startAt);
    out.current.nextAt = startAt + buffer.duration;
    out.current.sources.add(src);
    src.onended = () => {
      out.current?.sources.delete(src);
      if (out.current && out.current.sources.size === 0) {
        setStatus((st) => (st === "speaking" ? "listening" : st));
      }
    };
    setStatus("speaking");
  };
  const stopPlayback = () => {
    if (!out.current) return;
    for (const s of out.current.sources) {
      try {
        s.stop();
      } catch {}
    }
    out.current.sources.clear();
    out.current.nextAt = 0;
  };

  // ---- tool calls from the model: run against the same backend tools as text chat ----
  const handleToolCall = async (msg: LiveServerMessage) => {
    const calls = msg.toolCall?.functionCalls ?? [];
    const functionResponses = [];
    let ended: string | null = null;
    for (const call of calls) {
      const name = call.name ?? "";
      let response: Record<string, unknown>;
      try {
        if (!AGENT_TOOLS.has(name)) throw new Error(`Tool ${name} not available`);
        const result = await callTool(name, sessionId, call.args ?? {});
        response = { result };
        if (name === "finish_interview") ended = "reviewing";
        if (name === "pause") ended = "paused";
      } catch (e) {
        response = { error: e instanceof Error ? e.message : String(e) };
      }
      functionResponses.push({ id: call.id, name, response });
    }
    session.current?.sendToolResponse({ functionResponses });
    cb.current.onChange();
    if (ended) {
      // Let the agent say its goodbye line, then hang up.
      setTimeout(() => {
        stopRef.current();
        cb.current.onEnded(ended!);
      }, 4000);
    }
  };

  const onMessage = (msg: LiveServerMessage) => {
    const sc = msg.serverContent;
    if (msg.toolCall) void handleToolCall(msg);
    if (msg.goAway) void reconnect("Server asked to reconnect");
    if (!sc) return;
    if (sc.inputTranscription?.text) {
      userBuf.current += sc.inputTranscription.text;
      clearSilence();
      silence.current.nudges = 0;
    }
    if (sc.interrupted) {
      stopPlayback(); // barge-in: the owner talked over the agent
      void flush("agent");
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
        if (userBuf.current) void flush("user");
        clearSilence();
        play(part.inlineData.data);
      }
    }
    if (sc.outputTranscription?.text) {
      if (userBuf.current) void flush("user");
      agentBuf.current += sc.outputTranscription.text;
    }
    if (sc.turnComplete) {
      void flush("user");
      void flush("agent");
      armSilence();
    }
  };

  // ---- connect / reconnect ----
  const connect = async (kickoff: string) => {
    const res = await fetch("/api/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    if (json.status === "paused") await callTool("resume", sessionId, {});

    const ai = new GoogleGenAI({ apiKey: json.token, httpOptions: { apiVersion: "v1alpha" } });
    const s = await ai.live.connect({
      model: json.model,
      config: json.config,
      callbacks: {
        onopen: () => {},
        onmessage: onMessage,
        onerror: (e) => console.warn("[voice] error", e),
        onclose: (e) => {
          session.current = null;
          if (wanted.current) void reconnect(e?.reason || "connection closed");
        },
      },
    });
    session.current = s;
    reconnects.current = 0;
    setStatus("listening");
    s.sendRealtimeInput({ text: kickoff });
  };

  const reconnect = async (reason: string) => {
    if (!wanted.current) return;
    console.warn("[voice] reconnecting:", reason);
    try {
      session.current?.close();
    } catch {}
    session.current = null;
    stopPlayback();
    void flush("user");
    void flush("agent");
    if (reconnects.current >= MAX_RECONNECTS) {
      setStatus("error");
      setError("Voice connection keeps dropping. Your answers are saved — continue by typing, or try voice again.");
      wanted.current = false;
      teardownAudio();
      return;
    }
    reconnects.current += 1;
    setStatus("reconnecting");
    await new Promise((r) => setTimeout(r, 800 * reconnects.current));
    try {
      await connect("(The call dropped and reconnected. Say 'Sorry, we got cut off' in a few words, then ask the current question again.)");
    } catch (e) {
      void reconnect(e instanceof Error ? e.message : String(e));
    }
  };

  const teardownAudio = () => {
    mic.current?.node.disconnect();
    mic.current?.stream.getTracks().forEach((t) => t.stop());
    void mic.current?.ctx.close();
    mic.current = null;
    stopPlayback();
    void out.current?.ctx.close();
    out.current = null;
    setLevel(0);
  };

  const start = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    wanted.current = true;
    reconnects.current = 0;
    silence.current.nudges = 0;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      const ctx = new AudioContext({ sampleRate: 16000 });
      await ctx.audioWorklet.addModule("/pcm-recorder-worklet.js");
      const node = new AudioWorkletNode(ctx, "pcm-recorder");
      ctx.createMediaStreamSource(stream).connect(node);
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const pcm = new Int16Array(e.data);
        let sum = 0;
        for (let i = 0; i < pcm.length; i += 8) sum += Math.abs(pcm[i]);
        setLevel(Math.min(1, (sum / (pcm.length / 8) / 0x8000) * 6));
        if (mutedRef.current || !session.current) return;
        session.current.sendRealtimeInput({ audio: { data: toBase64(e.data), mimeType: "audio/pcm;rate=16000" } });
      };
      mic.current = { stream, ctx, node };
      out.current = { ctx: new AudioContext({ sampleRate: 24000 }), nextAt: 0, sources: new Set() };

      await connect(
        "(The owner just switched to a voice call. Greet them in a few words — or if the conversation so far is not empty, say you're continuing by voice — then ask the next question.)",
      );
    } catch (e) {
      wanted.current = false;
      teardownAudio();
      const msg = e instanceof Error ? e.message : String(e);
      setStatus("error");
      setError(
        /Permission|NotAllowed|denied/i.test(msg)
          ? "Microphone access was blocked. Allow the mic in your browser, or keep going by typing."
          : `Could not start voice: ${msg}. You can keep going by typing.`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const stop = useCallback(() => {
    wanted.current = false;
    clearSilence();
    void flush("user");
    void flush("agent");
    try {
      session.current?.close();
    } catch {}
    session.current = null;
    teardownAudio();
    setStatus("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flush]);

  const toggleMute = useCallback(() => {
    mutedRef.current = !mutedRef.current;
    setMuted(mutedRef.current);
  }, []);

  useEffect(() => {
    stopRef.current = stop;
    return () => stop();
  }, [stop]);

  return { status, error, level, muted, start, stop, toggleMute };
}
