/**
 * What is playing, as a few characters that fit in a URL.
 *
 *   1.96.100.50.0.0.4751.x.b970
 *   │ │  │   │  │ │ └──┴─┴── one per ball, lo mid hi: x = in its nest, or
 *   │ │  │   │  │ │          pad (hex) · stride x+6 · stride y+6 · phase (all base 36)
 *   │ │  │   │  │ └ root, semitones above C
 *   │ │  │   │  └ scale
 *   │ │  │   └ tone, 0–100
 *   │ │  └ bounce knob, 0–100 (93 and up is ∞)
 *   │ └ tempo, bpm
 *   └ version
 *
 * No DOM. Anything that does not parse is refused whole, so a mangled link
 * opens the instrument as it normally is.
 */

import { period } from "./engine.ts";
import type { Throw } from "./engine.ts";

export interface Patch {
  tempo: number;
  bounce: number;
  tone: number;
  scale: number;
  root: number;
  throws: (Throw | null)[];
}

export const LIMITS = { tempo: [60, 150], bounce: [0, 100], tone: [0, 100], root: [0, 11] } as const;
/** the longest stride a ball can be on: from the farthest nest to the top row is five wells, and one to spare */
const REACH = 6;

const int = (s: string, lo: number, hi: number): number | null => {
  if (!/^\d{1,3}$/.test(s)) return null;
  const v = Number(s);
  return v >= lo && v <= hi ? v : null;
};

export function encode(p: Patch): string {
  const balls = [0, 1, 2].map((i) => {
    const t = p.throws[i];
    if (!t) return "x";
    return t.pad.toString(16) + (t.sx + REACH).toString(36) + (t.sy + REACH).toString(36) + t.phase.toString(36);
  });
  return [1, p.tempo, p.bounce, p.tone, p.scale, p.root, ...balls].join(".");
}

export function decode(token: string, scales: number): Patch | null {
  const parts = token.replace(/^#/, "").split(".");
  if (parts.length !== 9 || parts[0] !== "1") return null;
  const tempo = int(parts[1], ...LIMITS.tempo);
  const bounce = int(parts[2], ...LIMITS.bounce);
  const tone = int(parts[3], ...LIMITS.tone);
  const scale = int(parts[4], 0, scales - 1);
  const root = int(parts[5], ...LIMITS.root);
  if (tempo === null || bounce === null || tone === null || scale === null || root === null) return null;
  const throws: (Throw | null)[] = [];
  for (const b of parts.slice(6)) {
    if (b === "x") {
      throws.push(null);
      continue;
    }
    if (!/^[0-9a-f][0-9a-c][0-9a-c][0-9a-z]{1,2}$/.test(b)) return null;
    const sx = parseInt(b[1], 36) - REACH;
    const sy = parseInt(b[2], 36) - REACH;
    const phase = parseInt(b.slice(3), 36);
    if (phase >= period(sx, sy)) return null;
    throws.push({ pad: parseInt(b[0], 16), sx, sy, phase });
  }
  return { tempo, bounce, tone, scale, root, throws };
}
