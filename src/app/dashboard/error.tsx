"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { buttonClasses } from "@/lib/ui";
import { StatePanel } from "@/components/state-panel";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatePanel
      icon={<AlertTriangle className="h-5 w-5 text-danger" aria-hidden="true" />}
      title="Something went wrong"
      description="This page hit an unexpected error. Try again, or head back to your repositories."
      action={
        <div className="flex gap-3">
          <button type="button" onClick={reset} className={buttonClasses("secondary")}>
            Try again
          </button>
          <a href="/dashboard" className={buttonClasses("primary")}>
            Back to dashboard
          </a>
        </div>
      }
    />
  );
}
