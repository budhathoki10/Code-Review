import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import { sendTestPush } from "@/lib/push/delivery";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Invalid origin." }, { status: 403 });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "Expected JSON." }, { status: 400 });
  }
  let endpoint: unknown;
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Invalid push endpoint." }, { status: 400 });
    endpoint = (JSON.parse(text) as { endpoint?: unknown }).endpoint;
  } catch { /* Invalid body. */ }
  if (typeof endpoint !== "string" || endpoint.length > 2048) {
    return Response.json({ error: "Invalid push endpoint." }, { status: 400 });
  }
  try {
    const result = await sendTestPush(session.user.id, endpoint);
    if (result === "sent") return Response.json({ ok: true });
    if (result === "expired") return Response.json({ error: "This browser's subscription expired. Turn notifications off and on again." }, { status: 410 });
    if (result === "missing") return Response.json({ error: "Enable notifications on this browser first." }, { status: 404 });
    return Response.json({ error: "Push is not configured on this deployment." }, { status: 503 });
  } catch (error) {
    logger.warn({ userId: session.user.id, err: error }, "test push failed");
    return Response.json({ error: "The push service did not accept the test. Try again shortly." }, { status: 502 });
  }
}
