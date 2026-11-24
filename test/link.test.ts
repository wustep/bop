/**
 * A link has to survive the trip: whatever is written down reads back the
 * same, and nothing that is not a link is taken for one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { period } from "../src/engine.ts";
import { decode, encode } from "../src/link.ts";
import type { Patch } from "../src/link.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

test("every patch reads back as it was written", () => {
  const rnd = rng(42);
  const pick = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  for (let i = 0; i < 2000; i++) {
    const p: Patch = {
      tempo: pick(60, 150),
      bounce: pick(0, 100),
      tone: pick(0, 100),
      scale: pick(0, 5),
      root: pick(0, 11),
      throws: [0, 1, 2].map(() => {
        if (rnd() < 0.25) return null;
        const sx = pick(-6, 6);
        const sy = pick(-6, 6);
        return { pad: pick(0, 15), sx, sy, phase: pick(0, period(sx, sy) - 1) };
      }),
    };
    const token = encode(p);
    assert.ok(/^[0-9a-z.]+$/.test(token), `only plain characters: ${token}`);
    assert.ok(token.length <= 35, `short: ${token}`);
    assert.deepEqual(decode(token, 6), p, token);
    assert.deepEqual(decode("#" + token, 6), p, "with the hash still on");
  }
});

test("the instrument as it first opens is one short token", () => {
  const token = encode({ tempo: 96, bounce: 100, tone: 50, scale: 0, root: 0, throws: [null, null, null] });
  assert.equal(token, "1.96.100.50.0.0.x.x.x");
});

test("anything that is not a link is refused", () => {
  const bad = [
    "",
    "#",
    "hello",
    "2.96.100.50.0.0.x.x.x", // a version from the future
    "1.96.100.50.0.0.x.x", // a ball short
    "1.96.100.50.0.0.x.x.x.x",
    "1.59.100.50.0.0.x.x.x", // slower than the knob goes
    "1.151.100.50.0.0.x.x.x",
    "1.96.101.50.0.0.x.x.x",
    "1.96.100.50.6.0.x.x.x", // no such scale
    "1.96.100.50.0.12.x.x.x", // no such root
    "1.96.100.50.0.0.g660.x.x", // no such pad
    "1.96.100.50.0.0.4d60.x.x", // stride too long
    "1.96.100.50.0.0.4662.x.x", // a dribble only has two phases
    "1.96.100.50.0.0.4768.x.x", // nor does a one-well stride have a ninth step
    "1.96.100.50.0.0.476.x.x",
    "1.96.100.50.0.0.476000.x.x",
    "1.9e1.100.50.0.0.x.x.x",
    "1.96.100.50.0.0.<script>.x.x",
  ];
  for (const b of bad) assert.equal(decode(b, 6), null, JSON.stringify(b));
});
