"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { callTool } from "@/lib/client";

export default function SharedBrief() {
  const { id } = useParams<{ id: string }>();
  const [brief, setBrief] = useState<{ revision: number; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    callTool<{ revision: number; content: string }>("get_shared", id)
      .then(setBrief)
      .catch((e) => setError(e.message));
  }, [id]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <p className="text-sm font-medium uppercase tracking-wider text-teal-700">Problem brief for builders</p>
      {error ? (
        <p className="mt-4 rounded-lg bg-stone-100 px-4 py-3 text-stone-700">{error}</p>
      ) : !brief ? (
        <p className="mt-4 text-stone-500">Loading…</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-stone-500">
            Approved revision {brief.revision} · sensitive details redacted by the owner
          </p>
          <article className="mt-6 rounded-2xl border border-stone-200 bg-white p-6">
            <Markdown text={brief.content} />
          </article>
        </>
      )}
    </main>
  );
}
