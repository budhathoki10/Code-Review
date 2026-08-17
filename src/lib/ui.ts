export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export function buttonClasses(variant: ButtonVariant = "primary") {
  const base =
    "inline-flex h-10 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50";

  switch (variant) {
    case "secondary":
      return `${base} border border-border px-4 text-foreground hover:bg-surface-hover active:bg-border`;
    case "ghost":
      return `${base} px-3 text-muted hover:bg-surface-hover hover:text-foreground active:bg-border`;
    case "destructive":
      return `${base} bg-danger px-4 text-white hover:opacity-90 active:opacity-80`;
    case "primary":
    default:
      return `${base} bg-accent px-5 text-accent-foreground hover:opacity-90 active:opacity-80`;
  }
}

/** Small square icon-only trigger — row actions, close buttons. Always pair with an aria-label. */
export function iconButtonClasses() {
  return "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50";
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: "danger",
  high: "danger",
  medium: "warning",
  low: "neutral",
  info: "neutral",
};

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
};

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-subtle",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

/** Text color for a semantic tone — status labels, finding severities, verdicts. */
export function toneTextClasses(tone: Tone) {
  return TONE_TEXT[tone];
}

/** A small solid dot in the same tone, meant to sit inline before a label. */
export function toneDotClasses(tone: Tone) {
  return `h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`;
}

/** Just the background color for a tone, unsized — segments of a bar, swatches, etc. */
export function toneBgClasses(tone: Tone) {
  return TONE_DOT[tone];
}
