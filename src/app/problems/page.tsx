"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { callTool } from "@/lib/client";

type Item = { id: string; revision: number; summary: string; open_questions: number; shared_at: string };

export default function ProblemBoard() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    callTool<Item[]>("list_shared", null)
      .then(setItems)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <p className="text-sm font-medium uppercase tracking-wider text-teal-700">Problem Board</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">Real business problems, ready for builders</h1>
      <p className="mt-2 text-stone-600">
        Every brief here came from an interview with the business owner, who reviewed, redacted and approved it before
        sharing.{" "}
        <Link href="/" className="font-medium text-teal-700 underline">
          Post your problem →
        </Link>
      </p>
      {error && <p className="mt-6 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!items && !error && <p className="mt-6 text-stone-500">Loading…</p>}
      {items?.length === 0 && <p className="mt-6 text-stone-500">No shared problems yet.</p>}
      <ul className="mt-6 space-y-3">
        {items?.map((p) => (
          <li key={p.id}>
            <Link
              href={`/b/${p.id}`}
              className="block rounded-2xl border border-stone-200 bg-white p-5 transition hover:border-teal-600 hover:shadow-sm"
            >
              <p className="font-medium text-stone-900">{p.summary}</p>
              <p className="mt-2 text-xs text-stone-500">
                Approved revision {p.revision} · {p.open_questions} open questions · shared{" "}
                {new Date(p.shared_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
