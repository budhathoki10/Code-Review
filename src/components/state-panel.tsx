import type { ReactNode } from "react";

/** Shared shape for empty/error/first-run states: an icon, what happened, and what to do next. */
export function StatePanel({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="w-full max-w-sm">
        {icon && (
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-border text-muted">
            {icon}
          </div>
        )}
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p>
        {action && <div className="mt-6 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}
