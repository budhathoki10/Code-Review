"use client";

import type { ReactNode } from "react";
import { motion, type Variants } from "motion/react";

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: "easeOut" } },
};

/** Animates its direct children in one after another the first time the group enters the viewport. Children should be `StaggerItem`. */
export function StaggerGroup({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  /** Delays the whole sequence's start — lets a group wait for something else (e.g. a process indicator) to play first. */
  delay?: number;
}) {
  const container: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: 0.06, delayChildren: delay } },
  };

  return (
    <motion.div
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-80px" }}
      variants={container}
      className={className}
    >
      {children}
    </motion.div>
  );
}

const TAGS = {
  div: motion.div,
  span: motion.span,
  h1: motion.h1,
  p: motion.p,
} as const;

/**
 * A single animated child of `StaggerGroup`. `motion.h1`/`motion.span`/etc.
 * can only be referenced from inside a "use client" module — accessing them
 * directly in a Server Component file throws at request time — so every
 * tag this app needs is resolved here, once, and consumed as a plain
 * component reference from Server Components.
 */
export function StaggerItem({
  as = "div",
  children,
  className,
}: {
  as?: keyof typeof TAGS;
  children: ReactNode;
  className?: string;
}) {
  const Tag = TAGS[as];
  return (
    <Tag variants={staggerItem} className={className}>
      {children}
    </Tag>
  );
}
