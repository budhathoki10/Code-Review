"use client";

/**
 * The clickable file:line on a finding.
 *
 * A client component for one reason: the link sits inside the finding's
 * <summary>, so a click on it would also toggle the disclosure underneath it —
 * the reader asks to open the code and the card collapses instead. Stopping
 * propagation needs an event handler, and passing one from a Server Component
 * is not merely discouraged, it throws at render and takes the whole page with
 * it. That is exactly what it did: the repository dashboard failed to render
 * entirely, and neither the type checker nor the production build catches it,
 * because it is a runtime rule about the server/client boundary rather than a
 * type error.
 *
 * Kept as small as possible so the client bundle grows by an anchor and
 * nothing else; the card around it stays a Server Component.
 */
export function CodeLocationLink({
  href,
  label,
  title,
}: {
  href: string;
  label: string;
  title?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => event.stopPropagation()}
      className="truncate font-mono text-xs font-medium text-foreground underline decoration-border underline-offset-2 transition-colors hover:decoration-foreground focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      title={title}
    >
      {label}
    </a>
  );
}
