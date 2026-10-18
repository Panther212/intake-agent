import { Suspense } from "react";
import SessionView from "./session-view";

export default function SessionPage() {
  return (
    <Suspense fallback={<div className="p-8 text-stone-500">Loading interview…</div>}>
      <SessionView />
    </Suspense>
  );
}
