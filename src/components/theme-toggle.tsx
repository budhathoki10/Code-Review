"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { iconButtonClasses } from "@/lib/ui";

type ThemeChoice = "system" | "light" | "dark";

const ORDER: ThemeChoice[] = ["system", "light", "dark"];
const ICON: Record<ThemeChoice, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };
const LABEL: Record<ThemeChoice, string> = { system: "System theme", light: "Light theme", dark: "Dark theme" };

function applyTheme(choice: ThemeChoice) {
  if (choice === "system") {
    document.documentElement.removeAttribute("data-theme");
    window.localStorage.removeItem("theme");
  } else {
    document.documentElement.setAttribute("data-theme", choice);
    window.localStorage.setItem("theme", choice);
  }
}

/**
 * Cycles system → light → dark. The actual attribute is set synchronously by
 * an inline script in the root layout's <head> to avoid a flash on load;
 * this just reflects/updates that same choice after hydration.
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    // Reading localStorage during the initial render (instead of here) would
    // desync from the server-rendered HTML and trigger a hydration mismatch,
    // since the server can't see the client's stored preference.
    const stored = window.localStorage.getItem("theme");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored === "light" || stored === "dark") setChoice(stored);
  }, []);

  const Icon = ICON[choice];

  return (
    <button
      type="button"
      onClick={() => {
        const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
        setChoice(next);
        applyTheme(next);
      }}
      className={iconButtonClasses()}
      aria-label={`Theme: ${LABEL[choice]}. Click to change.`}
      title={LABEL[choice]}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
