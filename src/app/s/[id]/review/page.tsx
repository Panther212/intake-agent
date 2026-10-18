import { Suspense } from "react";
import ReviewView from "./review-view";

export default function ReviewPage() {
  return (
    <Suspense fallback={<div className="p-8 text-stone-500">Loading review…</div>}>
      <ReviewView />
    </Suspense>
  );
}
