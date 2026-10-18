// Tiny Markdown renderer for generated briefs: headings, bullets, bold, paragraphs.
import { Fragment } from "react";

function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (!list.length) return;
    out.push(
      <ul key={`ul${out.length}`} className="my-2 list-disc space-y-1 pl-5">
        {list.map((l, i) => (
          <li key={i}>{inline(l)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flush();
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      const size = h[1].length <= 2 ? "text-lg" : "text-base";
      out.push(
        <h3 key={out.length} className={`mt-4 mb-1 font-semibold text-stone-900 ${size}`}>
          {inline(h[2])}
        </h3>,
      );
    } else if (line.trim()) {
      out.push(
        <p key={out.length} className="my-1.5">
          {inline(line)}
        </p>,
      );
    }
  }
  flush();
  return <div className="text-[15px] leading-relaxed text-stone-700">{out}</div>;
}
