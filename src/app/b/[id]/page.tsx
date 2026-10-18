import { Suspense } from "react";
import SharedBrief from "./shared-brief";

export default function SharedBriefPage() {
  return (
    <Suspense fallback={<div className="p-8 text-stone-500">Loading brief…</div>}>
      <SharedBrief />
    </Suspense>
  );
}
