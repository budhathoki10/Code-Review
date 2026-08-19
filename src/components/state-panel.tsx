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
    <div className="flex flex-1 items-center justify-center py-10">
      <div className="w-full max-w-xl rounded-lg border border-border bg-card px-6 py-10 text-left sm:px-10">
        {icon && (
          <div className="mb-8 flex h-10 w-10 items-center justify-center border border-border text-muted">
            {icon}
          </div>
        )}
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-subtle">Workspace status</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-foreground">{title}</h2>
        <p className="mt-3 max-w-md text-sm leading-6 text-muted">{description}</p>
        {action && <div className="mt-7 flex">{action}</div>}
      </div>
    </div>
  );
}
