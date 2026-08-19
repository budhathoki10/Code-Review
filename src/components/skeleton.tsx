/** A single pulsing placeholder block. Compose these to match the exact shape of the content being loaded, so nothing shifts when it lands. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-border ${className ?? ""}`} />;
}
