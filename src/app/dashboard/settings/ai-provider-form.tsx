"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AlertCircle, Check, ChevronDown, Loader2, Search, ShieldCheck } from "lucide-react";
import { buttonClasses } from "@/lib/ui";
import { useToast } from "@/components/toast";
import type { CatalogProvider } from "@/lib/ai/catalog";
import { clearAiSettings, saveAiSettings } from "./actions";

/** What the server is willing to tell the browser about a stored key. Never the key. */
export interface StoredAiSettings {
  providerId: string;
  model: string;
  keyLast4: string;
  verifiedAt: string;
  disabled: boolean;
  lastError?: string;
  contextLimit?: number;
  maxOutput?: number;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
}

function formatTokens(count?: number): string {
  if (!count) return "—";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return String(count);
}

function formatPrice(perMTok?: number): string {
  if (perMTok === undefined) return "—";
  if (perMTok === 0) return "Free";
  return `$${perMTok < 0.01 ? perMTok.toFixed(4) : perMTok.toFixed(2)}`;
}

/**
 * A searchable single-select.
 *
 * The dashboard has no native `<select>` anywhere, and this list cannot be
 * one regardless: a single provider can offer three hundred models, which is
 * unusable without a filter. Built on the same popover shape as
 * review-filter.tsx so it reads as part of the same product.
 */
function Combobox<T>({
  label,
  items,
  selected,
  onSelect,
  keyOf,
  titleOf,
  hintOf,
  placeholder,
  disabled,
  emptyLabel,
}: {
  label: string;
  items: T[];
  selected?: T;
  onSelect: (item: T) => void;
  keyOf: (item: T) => string;
  titleOf: (item: T) => string;
  hintOf: (item: T) => string | undefined;
  placeholder: string;
  disabled?: boolean;
  emptyLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? items.filter((item) => `${titleOf(item)} ${keyOf(item)}`.toLowerCase().includes(needle))
      : items;
    // Capped so a three-hundred-model provider does not render three hundred
    // rows into the DOM on every keystroke. Search is how you reach the rest.
    return matches.slice(0, 50);
  }, [items, query, titleOf, keyOf]);

  return (
    <div ref={rootRef} className="relative">
      <span className="text-xs font-medium text-muted">{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="mt-1.5 flex h-10 w-full items-center justify-between gap-2 rounded-[2px] border border-border bg-background px-2.5 text-left text-sm text-foreground transition-colors hover:border-foreground/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={selected ? "truncate text-foreground" : "truncate text-subtle"}>
          {selected ? titleOf(selected) : placeholder}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-subtle transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={label}
          className="absolute top-full left-0 z-30 mt-1.5 w-full rounded-md border border-border bg-card p-1.5 shadow-[0_18px_48px_rgba(20,20,16,0.14)]"
        >
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" aria-hidden="true" />
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search…"
              aria-label={`Search ${label.toLowerCase()}`}
              className="h-9 w-full rounded-[2px] border border-border bg-background pr-2.5 pl-8 text-sm text-foreground placeholder:text-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
          </div>

          <div className="mt-1.5 max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-2.5 py-3 text-xs text-subtle">{emptyLabel}</p>
            ) : (
              filtered.map((item) => {
                const isSelected = selected !== undefined && keyOf(selected) === keyOf(item);
                const hint = hintOf(item);
                return (
                  <button
                    key={keyOf(item)}
                    type="button"
                    onClick={() => { onSelect(item); setOpen(false); setQuery(""); }}
                    aria-current={isSelected ? "true" : undefined}
                    className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <Check className={`mt-0.5 h-4 w-4 shrink-0 text-accent ${isSelected ? "opacity-100" : "opacity-0"}`} aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">{titleOf(item)}</span>
                      {hint ? <span className="mt-0.5 block truncate text-xs text-subtle">{hint}</span> : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function AiProviderForm({
  providers,
  stored,
  catalogStale,
  storageAvailable,
  defaultModel,
}: {
  providers: CatalogProvider[];
  stored?: StoredAiSettings;
  catalogStale: boolean;
  storageAvailable: boolean;
  defaultModel: string;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  // Editing starts closed when something is already stored: the common visit
  // is to check what is set, not to change it.
  const [editing, setEditing] = useState(!stored);

  const [providerId, setProviderId] = useState(stored?.providerId ?? "");
  const [modelId, setModelId] = useState(stored?.model ?? "");
  const [apiKey, setApiKey] = useState("");

  const provider = providers.find((p) => p.id === providerId);
  const model = provider?.models.find((m) => m.id === modelId);
  const canSave = Boolean(provider && model && apiKey.trim() && storageAvailable);

  function handleSave() {
    if (!provider || !model) return;
    setError(undefined);
    startTransition(async () => {
      const result = await saveAiSettings({ providerId: provider.id, model: model.id, apiKey: apiKey.trim() });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setApiKey("");
      setEditing(false);
      toast({ title: "Model saved", description: `Reviews will now run on ${model.name}.` });
    });
  }

  function handleClear() {
    setError(undefined);
    startTransition(async () => {
      const result = await clearAiSettings();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setProviderId("");
      setModelId("");
      setApiKey("");
      setEditing(true);
      toast({ title: "Model removed", description: "Reviews are back on the built-in model." });
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 id="ai-provider-heading" className="text-sm font-semibold text-foreground">Review model</h2>
        <p className="mt-1 text-xs leading-5 text-muted">
          By default, reviews run on {defaultModel} at no cost to you. Connect your own provider to
          use a different model — you supply the key, and your provider bills you directly.
        </p>
      </div>

      {!storageAvailable && (
        <p role="alert" className="border-b border-border bg-warning/8 px-5 py-3 text-xs leading-5 text-foreground">
          This deployment cannot store API keys yet. Set <code className="font-mono">SECRETS_ENCRYPTION_KEY</code> to
          enable it.
        </p>
      )}

      {stored?.disabled && (
        <p role="alert" className="flex items-start gap-2 border-b border-border bg-danger/8 px-5 py-3 text-xs leading-5 text-foreground">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <span>
            Your key was rejected and has been disabled, so reviews are not running.
            {stored.lastError ? ` The provider said: ${stored.lastError}` : ""} Enter a new key to resume.
          </span>
        </p>
      )}

      {stored && !editing ? (
        <div className="px-5 py-4">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-subtle">Provider</dt>
              <dd className="mt-0.5 text-sm text-foreground">{provider?.name ?? stored.providerId}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle">Model</dt>
              <dd className="mt-0.5 truncate font-mono text-sm text-foreground">{stored.model}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle">API key</dt>
              <dd className="mt-0.5 font-mono text-sm text-foreground">{`••••••••${stored.keyLast4}`}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle">Verified</dt>
              <dd className="mt-0.5 flex items-center gap-1.5 text-sm text-foreground">
                {!stored.disabled && <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden="true" />}
                {new Date(stored.verifiedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
              </dd>
            </div>
          </dl>

          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={() => setEditing(true)} className={buttonClasses("secondary")}>
              Replace key
            </button>
            <button type="button" onClick={handleClear} disabled={pending} className={buttonClasses("ghost")}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Use the built-in model
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 px-5 py-4">
          <Combobox
            label="Provider"
            items={providers}
            selected={provider}
            onSelect={(next) => { setProviderId(next.id); setModelId(""); }}
            keyOf={(p) => p.id}
            titleOf={(p) => p.name}
            hintOf={(p) => `${p.models.length} model${p.models.length === 1 ? "" : "s"}`}
            placeholder="Choose a provider"
            disabled={!storageAvailable || pending}
            emptyLabel="No providers match that search."
          />

          <Combobox
            label="Model"
            items={provider?.models ?? []}
            selected={model}
            onSelect={(next) => setModelId(next.id)}
            keyOf={(m) => m.id}
            titleOf={(m) => m.name}
            hintOf={(m) => m.id}
            placeholder={provider ? "Choose a model" : "Choose a provider first"}
            disabled={!provider || !storageAvailable || pending}
            emptyLabel="No models match that search."
          />

          {model && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-[2px] border border-border bg-background px-3 py-2.5 sm:grid-cols-4">
              <div>
                <dt className="text-[11px] text-subtle">Context</dt>
                <dd className="mt-0.5 font-mono text-xs text-foreground">{formatTokens(model.contextLimit)}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-subtle">Max output</dt>
                <dd className="mt-0.5 font-mono text-xs text-foreground">{formatTokens(model.maxOutput)}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-subtle">Input / Mtok</dt>
                <dd className="mt-0.5 font-mono text-xs text-foreground">{formatPrice(model.costPerMTokIn)}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-subtle">Output / Mtok</dt>
                <dd className="mt-0.5 font-mono text-xs text-foreground">{formatPrice(model.costPerMTokOut)}</dd>
              </div>
            </dl>
          )}

          <div>
            <label htmlFor="apiKey" className="text-xs font-medium text-muted">API key</label>
            <input
              id="apiKey"
              type="password"
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              disabled={!storageAvailable || pending}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={provider ? `Your ${provider.name} key` : "Choose a provider first"}
              className="mt-1.5 w-full rounded-[2px] border border-border bg-background px-2.5 py-2 font-mono text-sm text-foreground placeholder:font-sans placeholder:text-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
            <p className="mt-1.5 text-xs leading-5 text-subtle">
              Encrypted before it is stored, and never shown again.{" "}
              {provider?.doc && (
                <a href={provider.doc} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2 hover:text-foreground">
                  Where to find your {provider.name} key
                </a>
              )}
              {" "}Use a key with a spend limit if your provider supports one.
            </p>
          </div>

          {error && (
            <p role="alert" className="flex items-start gap-1.5 text-xs leading-5 text-danger">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={handleSave} disabled={!canSave || pending} className={buttonClasses("primary")}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {pending ? "Checking your key…" : "Save and verify"}
            </button>
            {stored && (
              <button
                type="button"
                onClick={() => { setEditing(false); setApiKey(""); setError(undefined); }}
                disabled={pending}
                className={buttonClasses("ghost")}
              >
                Cancel
              </button>
            )}
          </div>

          {catalogStale && (
            <p className="text-xs text-subtle">
              Showing a cached model list — models.dev could not be reached just now.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
