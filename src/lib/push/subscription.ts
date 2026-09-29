export interface BrowserPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
  "api.push.apple.com",
]);

/** Only accept known browser push services; web-push makes server-side requests to this URL. */
export function parsePushSubscription(value: unknown): BrowserPushSubscription | null {
  if (!value || typeof value !== "object") return null;
  const input = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof input.endpoint !== "string" || input.endpoint.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || !(
    PUSH_HOSTS.has(host) || host.endsWith(".push.apple.com")
  )) return null;
  if (typeof input.keys?.p256dh !== "string" || typeof input.keys.auth !== "string") return null;
  if (!/^[A-Za-z0-9_-]{80,120}$/.test(input.keys.p256dh)) return null;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(input.keys.auth)) return null;
  return { endpoint: url.toString(), keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } };
}

export function pushConfigured(): boolean {
  return Boolean(process.env.VAPID_SUBJECT && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}
