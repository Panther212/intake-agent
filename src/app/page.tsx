"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { callTool, newDecisionId } from "@/lib/client";

export default function Home() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [line, setLine] = useState("");
  const [minutes, setMinutes] = useState("");
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setStep("Creating your session…");
      const { session_id } = await callTool<{ session_id: string }>(
        "create_session",
        null,
        { url: url.trim() || undefined, line, time_budget_min: minutes ? Number(minutes) : undefined },
        newDecisionId(),
      );
      setStep(url.trim() ? "Reading your website and organising what we already know…" : "Organising what we know…");
      await callTool("organize", session_id);
      router.push(`/s/${session_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep(null);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl">
        <p className="text-sm font-medium uppercase tracking-wider text-teal-700">Problem Intake Agent</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl">
          Turn a messy business problem into a brief builders can act on.
        </h1>
        <p className="mt-3 text-stone-600">
          Share your website and one line about what&apos;s going wrong. We read what&apos;s public, then interview you only
          about the gaps. Nothing is shared until you review and approve it.
        </p>

        <form onSubmit={start} className="mt-8 space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <label className="block">
            <span className="text-sm font-medium text-stone-800">Business website (optional)</span>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://yourbusiness.in"
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-stone-800">What&apos;s the problem, in one line?</span>
            <textarea
              required
              value={line}
              onChange={(e) => setLine(e.target.value)}
              rows={2}
              placeholder="Our outlets keep running out of milk by evening and managers reorder on WhatsApp"
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-stone-800">Minutes you have (optional)</span>
            <input
              type="number"
              min={1}
              max={30}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              placeholder="5"
              className="mt-1 w-28 rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            />
          </label>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={!!step}
            className="w-full rounded-lg bg-teal-700 px-4 py-2.5 font-medium text-white transition hover:bg-teal-800 disabled:opacity-70"
          >
            {step ?? "Start the interview"}
          </button>
        </form>
        <p className="mt-4 text-xs text-stone-500">Use fictional or non-sensitive details for demos.</p>
      </div>
    </main>
  );
}
