/**
 * Pad → pitch mapping.
 *
 * The tray is laid out isomorphically: one pad to the right is one scale
 * degree up, one pad up is roughly a fifth. A ball travelling in a straight
 * line therefore plays a constant interval, which is why any throw sounds
 * like an arpeggio instead of noise.
 */

export interface Scale {
  name: string;
  steps: number[];
  /** scale degrees between rows (chosen so a row is ~a fifth) */
  row: number;
}

export const SCALES: Scale[] = [
  { name: "penta", steps: [0, 2, 4, 7, 9], row: 3 },
  { name: "minor", steps: [0, 3, 5, 7, 10], row: 3 },
  { name: "dorian", steps: [0, 2, 3, 5, 7, 9, 10], row: 4 },
  { name: "major", steps: [0, 2, 4, 5, 7, 9, 11], row: 4 },
  { name: "hira", steps: [0, 2, 3, 7, 8], row: 3 },
  { name: "whole", steps: [0, 2, 4, 6, 8, 10], row: 3 },
];

export const ROOT = 60; // C4

/**
 * The root can be any of the twelve notes. Rather than climbing eleven
 * semitones to reach B, the upper half comes down instead (G is a fourth
 * below C, not a fifth above), so the tray never strays more than a tritone
 * from where the voices were tuned.
 */
export const rootShift = (root: number) => (root <= 6 ? root : root - 12);

const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

/** semitones above the root for a pad */
export function padSemis(col: number, row: number, scale: Scale): number {
  const deg = col + row * scale.row;
  const n = scale.steps.length;
  return 12 * Math.floor(deg / n) + scale.steps[deg % n];
}

export function noteName(semis: number): string {
  return NAMES[((semis % 12) + 12) % 12];
}

/**
 * Each ball reads the same pad in its own register.
 * 0 = low (big ball), 1 = mid, 2 = high (small ball).
 */
export function voiceMidi(voice: number, semis: number): number {
  const oct = Math.floor(semis / 12);
  const pc = semis - oct * 12;
  if (voice === 0) return ROOT - 12 + pc + (oct >= 2 ? 12 : 0);
  if (voice === 2) return ROOT + 12 + (oct >= 2 ? semis - 12 : semis);
  return ROOT + semis;
}
