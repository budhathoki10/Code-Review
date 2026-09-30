import { auth } from "@/auth";
import { ensureIndexes, pushSubscriptions } from "@/lib/db/collections";
import { parsePushSubscription, pushConfigured } from "@/lib/push/subscription";

export const runtime = "nodejs";

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin;
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return null;
  const text = await request.text();
  if (text.length > 4096) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin." }, { status: 403 });
  if (!pushConfigured()) return Response.json({ error: "Push is not configured on this deployment." }, { status: 503 });
  const subscription = parsePushSubscription(await readBody(request));
  if (!subscription) return Response.json({ error: "Invalid push subscription." }, { status: 400 });

  await ensureIndexes();
  const collection = await pushSubscriptions();
  const existing = await collection.findOne({ endpoint: subscription.endpoint });
  if (!existing && await collection.countDocuments({ userId: session.user.id }) >= 20) {
    return Response.json({ error: "Too many devices are subscribed to this account." }, { status: 429 });
  }
  const now = new Date();
  await collection.updateOne(
    { endpoint: subscription.endpoint },
    { $set: { userId: session.user.id, keys: subscription.keys, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin." }, { status: 403 });
  const body = await readBody(request);
  const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
  if (typeof endpoint !== "string" || endpoint.length > 2048) {
    return Response.json({ error: "Invalid push endpoint." }, { status: 400 });
  }
  await (await pushSubscriptions()).deleteOne({ userId: session.user.id, endpoint });
  return Response.json({ ok: true });
}
