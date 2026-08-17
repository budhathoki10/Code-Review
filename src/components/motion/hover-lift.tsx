"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";

/** Wraps a single interactive child (typically a primary CTA) with a restrained 1px lift on hover — no scale. */
export function HoverLift({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={`inline-block ${className ?? ""}`}
      whileHover={{ y: -1 }}
      whileTap={{ y: 0 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}
