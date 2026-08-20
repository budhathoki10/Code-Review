import type { NextRequest } from "next/server";

/**
 * Builds absolute redirect URLs from the app's known public origin (AUTH_URL)
 * rather than from the incoming request. Behind a tunnel (ngrok), Next.js can
 * misreport the request's own origin as the local bind address while still
 * carrying an https scheme — producing an https://localhost URL that no
 * browser can actually connect to.
 */
export function appUrl(path: string, request: NextRequest): URL {
  const base = process.env.AUTH_URL ?? request.url;
  return new URL(path, base);
}
