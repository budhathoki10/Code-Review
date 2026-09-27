import { logger } from "@/lib/logger";

/**
 * The catalogue of providers and models a user can choose from, built from
 * models.dev.
 *
 * Only the settings page reads this. A review never does: the model's limits
 * and prices are snapshotted onto the user's settings document when they
 * choose, so starting a review never depends on a third-party HTTP call.
 */

const CATALOG_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export interface CatalogModel {
  id: string;
  name: string;
  /** Total input window, in tokens. */
  contextLimit?: number;
  /** Output ceiling, in tokens. Clamps the stage budgets — see models.ts. */
  maxOutput?: number;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
  reasoning?: boolean;
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** OpenAI-compatible base URL. The presence of this is why the provider is listed at all. */
  baseUrl: string;
  /** The provider's own docs, for a "where do I get a key" link. */
  doc?: string;
  models: CatalogModel[];
}

/** The shape of models.dev's payload that this code depends on. */
interface RawModel {
  id?: unknown;
  name?: unknown;
  tool_call?: unknown;
  reasoning?: unknown;
  limit?: { context?: unknown; output?: unknown };
  cost?: { input?: unknown; output?: unknown };
}
interface RawProvider {
  id?: unknown;
  name?: unknown;
  api?: unknown;
  doc?: unknown;
  models?: Record<string, RawModel>;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * OpenAI-compatible endpoints for providers models.dev does not give an `api`
 * field to.
 *
 * models.dev sets `api` only for providers it routes through a *generic*
 * OpenAI-compatible adapter. The major first-party providers each have their
 * own SDK entry instead (`@ai-sdk/anthropic`, `@ai-sdk/openai`, ...), so they
 * carry no `api` — even though most of them, OpenAI included, serve a
 * perfectly good OpenAI-shaped endpoint. Filtering on `api` alone therefore
 * dropped Anthropic, OpenAI, Google, xAI, Groq, Mistral, Cerebras and
 * Together: roughly 160 usable models, and every name a user would look for
 * first.
 *
 * Each URL here was checked against the live endpoint. Keyed by models.dev
 * provider id so the model list, limits and prices still come from the
 * catalogue rather than being hand-maintained here.
 */
const FIRST_PARTY_BASE_URLS: Record<string, string> = {
  // Anthropic documents this as a compatibility layer for evaluating models
  // rather than a production surface — `strict` and `response_format` are
  // ignored and prompt caching is unavailable — but tool calling, which is
  // the one thing this pipeline cannot work without, is fully supported.
  anthropic: "https://api.anthropic.com/v1/",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/",
  xai: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  // Gateways and inference hosts that speak the OpenAI protocol with a plain
  // bearer key.
  vercel: "https://ai-gateway.vercel.sh/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  venice: "https://api.venice.ai/api/v1",
  aihubmix: "https://aihubmix.com/v1",
  cohere: "https://api.cohere.ai/compatibility/v1",
};

/**
 * Providers deliberately left out, and why — so this is not re-litigated
 * every time someone notices a familiar name missing.
 *
 * All of them have tool-call models. None can be reached with what a user can
 * type into a form: one static base URL plus one bearer token.
 *
 * - `amazon-bedrock` signs every request with AWS SigV4, not a bearer token.
 * - `azure`, `azure-cognitive-services` and `cloudflare-ai-gateway` put the
 *   customer's own resource or account id in the URL, so there is no single
 *   base URL to publish.
 * - `google-vertex` and `google-vertex-anthropic` need GCP application
 *   default credentials plus a project and region.
 * - `sap-ai-core`, `gitlab`, `watsonx`, `qvac`, `salad-cloud` and `v0` either
 *   use bespoke auth or serve no OpenAI-compatible route (v0's `/v1/models`
 *   returns 404).
 *
 * Supporting any of these means a per-provider credential form, not another
 * line in the table above.
 */

/**
 * Providers this app can actually reach, with models it can actually use.
 *
 * Two filters, both load-bearing:
 *
 * - A provider needs an OpenAI-compatible base URL, from the catalogue or
 *   from FIRST_PARTY_BASE_URLS above. This app has one client, and it speaks
 *   the OpenAI protocol.
 * - A model without `tool_call` cannot be used at all. Every stage of this
 *   pipeline extracts its result through a forced function call; a model that
 *   cannot call functions returns prose, which parses to nothing and reads to
 *   the user as "your code is clean".
 */
export function parseCatalog(payload: unknown): CatalogProvider[] {
  if (typeof payload !== "object" || payload === null) return [];

  const providers: CatalogProvider[] = [];
  for (const [providerId, raw] of Object.entries(payload as Record<string, RawProvider>)) {
    const baseUrl = typeof raw?.api === "string" ? raw.api : FIRST_PARTY_BASE_URLS[providerId];
    if (!baseUrl || !isSafeBaseUrl(baseUrl)) continue;

    const models: CatalogModel[] = [];
    for (const [modelId, model] of Object.entries(raw.models ?? {})) {
      if (model?.tool_call !== true) continue;
      models.push({
        id: typeof model.id === "string" ? model.id : modelId,
        name: typeof model.name === "string" ? model.name : modelId,
        contextLimit: numberOrUndefined(model.limit?.context),
        maxOutput: numberOrUndefined(model.limit?.output),
        costPerMTokIn: numberOrUndefined(model.cost?.input),
        costPerMTokOut: numberOrUndefined(model.cost?.output),
        reasoning: model.reasoning === true,
      });
    }
    if (models.length === 0) continue;

    models.sort((a, b) => a.name.localeCompare(b.name));
    providers.push({
      id: typeof raw.id === "string" ? raw.id : providerId,
      name: typeof raw.name === "string" ? raw.name : providerId,
      baseUrl,
      doc: typeof raw.doc === "string" ? raw.doc : undefined,
      models,
    });
  }

  providers.sort((a, b) => a.name.localeCompare(b.name));
  return providers;
}

/**
 * Whether a base URL from the catalogue is safe to send a request to.
 *
 * models.dev is third-party data and the settings form makes a live request
 * to whatever it names, so this is the boundary where that data stops being
 * trusted. Rejecting loopback and private ranges is what stops a catalogue
 * entry — mistaken or malicious — from turning this server into a probe of
 * its own internal network.
 */
export function isSafeBaseUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return false;
  }
  // Literal private and loopback addresses. A hostname that *resolves* to one
  // is not caught here — DNS is not resolved at this layer — which is why this
  // is one control among several rather than the only one.
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === "::1" || host === "[::1]" || host.startsWith("[fc") || host.startsWith("[fd")) return false;

  return true;
}

/**
 * A minimal catalogue for when models.dev cannot be reached.
 *
 * Small on purpose. Its job is to keep the settings page usable during an
 * outage, not to mirror a 200-provider catalogue by hand — a stale hand-kept
 * list that looks complete is worse than a short one that obviously is not.
 */
export const FALLBACK_CATALOG: CatalogProvider[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    doc: "https://openrouter.ai/models",
    models: [
      { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra 550B", contextLimit: 262_144, maxOutput: 182_520, costPerMTokIn: 0.6, costPerMTokOut: 2.4, reasoning: true },
      { id: "nvidia/nemotron-3-super-120b-a12b", name: "Nemotron 3 Super 120B", contextLimit: 262_144, maxOutput: 235_929, costPerMTokIn: 0.08, costPerMTokOut: 0.45, reasoning: true },
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    doc: "https://build.nvidia.com/models",
    models: [
      { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra 550B", contextLimit: 1_000_000, maxOutput: 65_536, costPerMTokIn: 0.5, costPerMTokOut: 2.5, reasoning: true },
      { id: "nvidia/nemotron-3-super-120b-a12b", name: "Nemotron 3 Super 120B", contextLimit: 262_144, maxOutput: 262_144, costPerMTokIn: 0.2, costPerMTokOut: 0.8, reasoning: true },
    ],
  },
];

let cached: { at: number; providers: CatalogProvider[] } | undefined;

/**
 * The catalogue, cached in process for a day.
 *
 * A plain module-level cache rather than a framework one: the worker has no
 * Next.js cache, the payload is a few hundred KB after filtering, and a
 * settings page that is opened a handful of times a day does not need
 * anything cleverer. A failed fetch serves the last good value if there is
 * one, and the fallback list otherwise — the page must always render.
 */
export async function getCatalog(): Promise<{ providers: CatalogProvider[]; stale: boolean }> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { providers: cached.providers, stale: false };
  }

  try {
    const response = await fetch(CATALOG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`models.dev responded ${response.status}`);

    const providers = parseCatalog(await response.json());
    if (providers.length === 0) throw new Error("models.dev returned no usable providers");

    cached = { at: Date.now(), providers };
    return { providers, stale: false };
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "could not refresh the models.dev catalogue",
    );
    // A stale catalogue still describes real models. Only fall all the way
    // back when there has never been a good one.
    return { providers: cached?.providers ?? FALLBACK_CATALOG, stale: true };
  }
}

/** Looks up one provider and model, so a form submission can be checked against the real catalogue. */
export function findModel(
  providers: CatalogProvider[],
  providerId: string,
  modelId: string,
): { provider: CatalogProvider; model: CatalogModel } | undefined {
  const provider = providers.find((p) => p.id === providerId);
  const model = provider?.models.find((m) => m.id === modelId);
  return provider && model ? { provider, model } : undefined;
}
