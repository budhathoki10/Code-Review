/** The product's mark — a pull-request glyph (source, target, merge point). Matches src/app/icon.tsx; kept as plain SVG here so it can adopt the accent token and sit inline in headers. */
export function BrandMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 18" fill="none" className={className} aria-hidden="true">
      <rect width="18" height="18" rx="5" className="fill-accent" />
      <circle cx="4.5" cy="4.5" r="2.1" className="stroke-accent-foreground" strokeWidth="1.5" />
      <circle cx="4.5" cy="13.5" r="2.1" className="stroke-accent-foreground" strokeWidth="1.5" />
      <circle cx="13.5" cy="4.5" r="2.1" className="stroke-accent-foreground" strokeWidth="1.5" />
      <path d="M4.5 6.6V11.4" className="stroke-accent-foreground" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M13.5 6.6C13.5 9.3 11.6 11.1 9.2 11.1"
        className="stroke-accent-foreground"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
