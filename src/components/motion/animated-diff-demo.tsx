"use client";

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { CheckCircle2 } from "lucide-react";
import { staggerItem, StaggerGroup } from "@/components/motion/stagger-group";

const STEPS = ["Understanding changes", "Analyzing", "Reviewing"];
const STEP_DELAY_MS = 380;
/** Diff lines wait for the last step to finish so the process reads as sequential, not simultaneous. */
const LINES_DELAY_S = (STEPS.length * STEP_DELAY_MS) / 1000;

function StepDot({ state }: { state: "pending" | "active" | "done" }) {
  if (state === "done") {
    return <CheckCircle2 className="h-3 w-3 text-success" aria-hidden="true" />;
  }
  if (state === "active") {
    return (
      <motion.span
        className="block h-2.5 w-2.5 rounded-full border-2 border-accent border-t-transparent"
        animate={{ rotate: 360 }}
        transition={{ duration: 0.6, repeat: Infinity, ease: "linear" }}
        aria-hidden="true"
      />
    );
  }
  return <span className="block h-2.5 w-2.5 rounded-full border border-border" aria-hidden="true" />;
}

/** A one-shot, timer-driven "the AI is working" strip — not a real process, just communicates one before the diff/finding reveal. */
function ProcessStrip() {
  const [step, setStep] = useState(-1);
  const started = useRef(false);

  return (
    <motion.div
      onViewportEnter={() => {
        if (started.current) return;
        started.current = true;
        STEPS.forEach((_, i) => setTimeout(() => setStep(i), i * STEP_DELAY_MS));
        setTimeout(() => setStep(STEPS.length), STEPS.length * STEP_DELAY_MS);
      }}
      viewport={{ once: true, margin: "-40px" }}
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border px-4 py-2.5"
    >
      {STEPS.map((label, i) => {
        const state = step > i ? "done" : step === i ? "active" : "pending";
        return (
          <span key={label} className="flex items-center gap-1.5">
            <StepDot state={state} />
            <span className={`text-[11px] ${state === "pending" ? "text-subtle" : "text-muted"}`}>{label}</span>
          </span>
        );
      })}
    </motion.div>
  );
}

/**
 * Hero-only animated version of the diff demo — a brief process strip, then
 * lines reveal one at a time. Deliberately separate from `DiffLines`/
 * `DiffBlock`, which stay plain (no "use client", no motion) since they're
 * also rendered on the dashboard's repo page.
 */
export function AnimatedDiffDemo({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, "").split("\n");

  return (
    <>
      <ProcessStrip />
      <StaggerGroup className="py-3" delay={LINES_DELAY_S}>
        {lines.map((line, i) => {
          const prefix = line[0];
          const tone =
            prefix === "+"
              ? "bg-success/10 text-success"
              : prefix === "-"
                ? "bg-danger/10 text-danger"
                : "text-foreground";
          return (
            <motion.div key={i} variants={staggerItem} className={`block px-4 ${tone}`}>
              {line || " "}
            </motion.div>
          );
        })}
      </StaggerGroup>
    </>
  );
}
