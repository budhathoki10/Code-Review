"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, AlertCircle, Info } from "lucide-react";
import type { Tone } from "@/lib/ui";

type ToastVariant = Extract<Tone, "success" | "danger" | "info">;

type Toast = { id: number; title: string; description?: string; variant: ToastVariant };

type ToastInput = { title: string; description?: string; variant?: ToastVariant };

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

const VARIANT_ICON: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  danger: AlertCircle,
  info: Info,
};

const VARIANT_ICON_TONE: Record<ToastVariant, string> = {
  success: "text-success",
  danger: "text-danger",
  info: "text-accent",
};

let nextId = 1;

/** App-wide toast stack — mounted once in the root layout. `useToast()` gives any client component a fire-and-forget `toast(...)` call. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    ({ title, description, variant = "success" }: ToastInput) => {
      const id = nextId++;
      setToasts((current) => [...current, { id, title, description, variant }]);
      setTimeout(() => dismiss(id), 4500);
    },
    [dismiss],
  );
  //returning the toast provider
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-end gap-2 p-4 sm:p-6" aria-live="polite">
        <AnimatePresence>
          {toasts.map((t) => {
            const Icon = VARIANT_ICON[t.variant];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.98 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                role="status"
                className="pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border border-border bg-card px-4 py-3 shadow-[0_18px_48px_rgba(20,20,16,0.14)]"
              >
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${VARIANT_ICON_TONE[t.variant]}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{t.title}</p>
                  {t.description && <p className="mt-0.5 text-xs text-muted">{t.description}</p>}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast must be used within a ToastProvider");
  return useMemo(() => toast, [toast]);
}
