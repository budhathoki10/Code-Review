"use client";

import { useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CheckCircle2 } from "lucide-react";

/**
 * Original visualization for the hero: changed files in a PR converging
 * into a single reviewed verdict. Single accent hue at varying opacity —
 * deliberately not a multi-color gradient. Each origin is labeled with a
 * filename and the destination with "Reviewed" — without that, this reads
 * as an unexplained moving line rather than "changes flow into one review."
 *
 * The base line draws in once; a small brighter "pulse" then travels along
 * it on an infinite loop, so the visualization reads as an ongoing flow
 * rather than a one-shot reveal that goes static.
 */
const STREAMS = [
  { y: 26, opacity: 0.3, label: "auth/session.ts" },
  { y: 62, opacity: 0.5, label: "api/webhook.ts" },
  { y: 98, opacity: 0.75, label: "review/pipeline.ts" },
  { y: 134, opacity: 0.5, label: "db/schema.ts" },
  { y: 170, opacity: 0.3, label: "worker/queue.ts" },
];

const NODE_X = 58;
const LINE_START_X = 70;
const END = { x: 420, y: 98 };

function streamPath(y: number) {
  return `M ${LINE_START_X} ${y} C 200 ${y}, 250 ${END.y}, ${END.x - 14} ${END.y}`;
}

export function HeroFlow() {
  const [started, setStarted] = useState(false);
  const triggered = useRef(false);
  const reducedMotion = useReducedMotion();

  return (
    <div className="relative mx-auto hidden h-[196px] w-full max-w-lg text-accent sm:block">
      <motion.svg
        viewBox="0 0 460 196"
        fill="none"
        className="h-full w-full overflow-visible"
        onViewportEnter={() => {
          if (triggered.current) return;
          triggered.current = true;
          setStarted(true);
        }}
        viewport={{ once: true, margin: "-40px" }}
      >
        {STREAMS.map((stream, i) => {
          const d = streamPath(stream.y);
          const drawDelay = i * 0.08;
          return (
            <g key={i}>
              <text
                x={NODE_X - 8}
                y={stream.y + 3}
                textAnchor="end"
                className="fill-subtle font-mono text-[9px]"
              >
                {stream.label}
              </text>
              <rect
                x={NODE_X}
                y={stream.y - 5}
                width={10}
                height={10}
                rx={2.5}
                className="fill-none stroke-border"
                strokeWidth={1.25}
              />
              <motion.path
                d={d}
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                style={{ opacity: stream.opacity }}
                initial={{ pathLength: 0 }}
                animate={started ? { pathLength: 1 } : { pathLength: 0 }}
                transition={{ duration: 0.7, ease: "easeOut", delay: drawDelay }}
              />
              {started && !reducedMotion && (
                <motion.path
                  d={d}
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeDasharray="10 460"
                  initial={{ strokeDashoffset: 0, opacity: 0 }}
                  animate={{ strokeDashoffset: -470, opacity: [0, 1, 1, 0] }}
                  transition={{
                    duration: 1.8,
                    repeat: Infinity,
                    ease: "linear",
                    delay: 0.7 + drawDelay + 0.15,
                  }}
                />
              )}
            </g>
          );
        })}
      </motion.svg>

      <motion.div
        initial={{ opacity: 0, scale: 0.7 }}
        animate={started ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.7 }}
        transition={{ duration: 0.3, ease: "easeOut", delay: 0.55 }}
        className="absolute flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-success"
        style={{ left: END.x, top: END.y, transform: "translate(-50%, -50%)" }}
      >
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
      </motion.div>
      <motion.span
        initial={{ opacity: 0 }}
        animate={started ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: 0.3, ease: "easeOut", delay: 0.7 }}
        className="absolute text-[10px] font-medium text-subtle"
        style={{ left: END.x, top: END.y + 26, transform: "translateX(-50%)" }}
      >
        Reviewed
      </motion.span>
    </div>
  );
}
