"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";
import { StaggerGroup, staggerItem } from "@/components/motion/stagger-group";

export interface Capability {
  /** Pre-rendered on the server — a component reference isn't serializable across the Server/Client boundary. */
  icon: ReactNode;
  title: string;
  body: string;
}

export function CapabilityGrid({ items }: { items: Capability[] }) {
  return (
    <StaggerGroup className="grid gap-4 sm:grid-cols-2">
      {items.map((item, i) => (
        <motion.div
          key={item.title}
          variants={staggerItem}
          whileHover={{ y: -2 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="rounded-lg border border-border p-5 transition-colors hover:border-accent/40"
        >
          <div className="flex items-center justify-between">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-foreground"
              aria-hidden="true"
            >
              {item.icon}
            </div>
            <span className="font-mono text-xs tabular-nums text-subtle" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
          </div>
          <h2 className="mt-4 text-sm font-semibold text-foreground">{item.title}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.body}</p>
        </motion.div>
      ))}
    </StaggerGroup>
  );
}
