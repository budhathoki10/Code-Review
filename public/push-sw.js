self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { /* Ignore malformed payloads. */ }
  const title = typeof payload.title === "string" ? payload.title : "PRSentry";
  const body = typeof payload.body === "string" ? payload.body : "A review update is available.";
  const url = typeof payload.url === "string" && payload.url.startsWith("/dashboard") ? payload.url : "/dashboard";
  const tag = typeof payload.tag === "string" ? payload.tag : "review-update";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/icon",
    tag,
    data: { url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/dashboard", self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url === url.href);
    if (existing) return existing.focus();
    return self.clients.openWindow(url.href);
  })());
});
