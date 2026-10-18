"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { callTool } from "@/lib/client";

// Opens each network's own share page; the person posts it themselves.
function ShareBar() {
  const [copied, setCopied] = useState(false);
  const url = typeof window !== "undefined" ? window.location.href : "";
  const text = "A real business problem looking for builders — interviewed, redacted and approved by the owner:";
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(text);
  const links = [
    { label: "LinkedIn", href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}` },
    { label: "WhatsApp", href: `https://wa.me/?text=${t}%20${u}` },
    { label: "X", href: `https://x.com/intent/post?text=${t}&url=${u}` },
  ];
  return (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <span className="text-sm text-stone-600">Share with builders:</span>
      {links.map((l) => (
        <a
          key={l.label}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:border-teal-600"
        >
          {l.label}
        </a>
      ))}
      <button
        onClick={() => navigator.clipboard.writeText(url).then(() => setCopied(true))}
        className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:border-teal-600"
      >
        {copied ? "Copied ✓" : "Copy link"}
      </button>
    </div>
  );
}

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
          <ShareBar />
          <article className="mt-4 rounded-2xl border border-stone-200 bg-white p-6">
            <Markdown text={brief.content} />
          </article>
          <Link href="/problems" className="mt-4 inline-block text-sm font-medium text-teal-700 underline">
            ← All problems on the board
          </Link>
        </>
      )}
    </main>
  );
}
