/** A compact review mark: the bracket is the code, the accent bars are the review signal. */
export function BrandMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect width="24" height="24" rx="2" className="fill-foreground" />
      <path d="M9.5 6.5H7.5V17.5H9.5" className="stroke-background" strokeWidth="1.75" />
      <path d="M13 8H17" className="stroke-success" strokeWidth="2" strokeLinecap="square" />
      <path d="M13 12H17" className="stroke-success" strokeWidth="2" strokeLinecap="square" />
      <path d="M13 16H15.5" className="stroke-success" strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}
