"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { buttonClasses } from "@/lib/ui";

type Status = "checking" | "off" | "on" | "blocked" | "unsupported";

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const padded = publicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(publicKey.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function saveSubscription(subscription: PushSubscription): Promise<void> {
  const response = await fetch("/api/push/subscription", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!response.ok) throw new Error((await response.json()).error ?? "Could not save the subscription.");
}

export function PushNotifications({ publicKey }: { publicKey?: string }) {
  const [status, setStatus] = useState<Status>(publicKey ? "checking" : "unsupported");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (!publicKey) return;
    let cancelled = false;
    (async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
          if (!cancelled) setStatus("unsupported");
          return;
        }
        if (Notification.permission === "denied") { setStatus("blocked"); return; }
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) await saveSubscription(subscription);
        if (!cancelled) setStatus(subscription ? "on" : "off");
      } catch {
        if (!cancelled) { setError("Could not check this browser's notification settings."); setStatus("off"); }
      }
    })();
    return () => { cancelled = true; };
  }, [publicKey]);

  async function enable() {
    if (!publicKey) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setStatus(permission === "denied" ? "blocked" : "off"); return; }
      const registration = await navigator.serviceWorker.register("/push-sw.js", { scope: "/" });
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      });
      try {
        await saveSubscription(subscription);
      } catch (saveError) {
        if (!existing) await subscription.unsubscribe();
        throw saveError;
      }
      setStatus("on");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch("/api/push/subscription", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        if (!response.ok) throw new Error("Could not remove this browser's subscription.");
        await subscription.unsubscribe();
      }
      setStatus("off");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription) throw new Error("This browser is no longer subscribed. Enable notifications again.");
      const response = await fetch("/api/push/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not send the test notification.");
      setMessage("Test sent. Look for a browser notification.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the test notification.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-10 border-t border-border pt-8" aria-labelledby="push-heading">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-muted" aria-hidden="true">{status === "on" ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}</span>
        <div>
          <h2 id="push-heading" className="text-base font-semibold text-foreground">Browser notifications</h2>
          <p className="mt-1 text-sm leading-6 text-muted">Get an alert on this device when a code review finishes or cannot complete.</p>
          <p className="mt-1 text-xs text-subtle" role="status">
            {status === "on" && "Enabled on this browser."}
            {status === "off" && "Off on this browser."}
            {status === "checking" && "Checking this browser…"}
            {status === "blocked" && "Notifications are blocked in your browser settings."}
            {status === "unsupported" && (publicKey ? "This browser does not support web push." : "Web push is not configured on this deployment.")}
          </p>
          {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
          {message && <p className="mt-2 text-sm text-success" role="status">{message}</p>}
          {(status === "on" || status === "off") && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className={buttonClasses("secondary")} onClick={status === "on" ? disable : enable} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {status === "on" ? "Turn off on this device" : "Enable notifications"}
              </button>
              {status === "on" && <button type="button" className={buttonClasses("secondary")} onClick={sendTest} disabled={busy}>Send test notification</button>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
