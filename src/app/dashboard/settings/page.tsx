import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { userSettings } from "@/lib/db/collections";
import { getCatalog } from "@/lib/ai/catalog";
import { secretsConfigured } from "@/lib/crypto/secret-box";
import { DEFAULT_MODEL } from "@/lib/ai/models";
import { AiProviderForm, type StoredAiSettings } from "./ai-provider-form";
import { PushNotifications } from "./push-notifications";
import { pushConfigured } from "@/lib/push/subscription";

export const metadata = { title: "Settings" };

/**
 * Account settings. Currently one section: which AI model reviews your code.
 *
 * Server-rendered so the catalogue is fetched once, on the server, and the
 * stored key never has a path to the browser — only its last four characters
 * and the metadata around it are projected into the client component.
 */
export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const [{ providers, stale }, settingsDoc] = await Promise.all([
    getCatalog(),
    (await userSettings()).findOne({ userId: session.user.id }),
  ]);

  const ai = settingsDoc?.ai;
  // Everything the form needs and nothing it does not. `keyCiphertext` is
  // deliberately absent: a server component's props are serialised into the
  // page, so anything named here is readable by anyone who can view source.
  const stored: StoredAiSettings | undefined = ai
    ? {
        providerId: ai.providerId,
        model: ai.model,
        keyLast4: ai.keyLast4,
        verifiedAt: ai.verifiedAt.toISOString(),
        disabled: Boolean(ai.disabledAt),
        lastError: ai.lastError?.message,
        contextLimit: ai.contextLimit,
        maxOutput: ai.maxOutput,
        costPerMTokIn: ai.costPerMTokIn,
        costPerMTokOut: ai.costPerMTokOut,
      }
    : undefined;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-subtle">Account</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-foreground">Settings</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted">
          Choose the model that reviews your pull requests. Applies to every repository you have connected.
        </p>
      </header>

      <section className="mt-8" aria-labelledby="ai-provider-heading">
        <AiProviderForm
          providers={providers}
          stored={stored}
          catalogStale={stale}
          storageAvailable={secretsConfigured()}
          defaultModel={process.env.NVIDIA_MODEL ?? DEFAULT_MODEL}
        />
      </section>
      <PushNotifications publicKey={pushConfigured() ? process.env.VAPID_PUBLIC_KEY : undefined} />
    </div>
  );
}
