export function buttonClasses(variant: "primary" | "secondary" = "primary") {
  const base =
    "inline-flex h-10 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50";

  if (variant === "secondary") {
    return `${base} border border-border px-4 text-foreground hover:bg-card active:bg-border`;
  }

  return `${base} bg-accent px-5 text-accent-foreground hover:opacity-90 active:opacity-80`;
}
