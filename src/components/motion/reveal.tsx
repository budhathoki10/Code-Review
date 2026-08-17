"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";

/** Fades an element in with a small upward shift the first time it enters the viewport. Never re-triggers on scroll back up. */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.24, ease: "easeOut", delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
