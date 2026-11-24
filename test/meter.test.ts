/**
 * The sound is judged by tools/meter.ts, so the meter is checked against
 * signals whose readings are known in advance.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { lufs, measure, onsets, peak } from "../tools/meter.ts";

const SR = 48000;

function sine(hz: number, amp: number, seconds: number): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return x;
}

test("a stereo 997 Hz sine at -20 dBFS reads -20 LUFS (the BS.1770 reference)", () => {
  const ch = [sine(997, 0.1, 5), sine(997, 0.1, 5)];
  assert.ok(Math.abs(peak(ch) + 20) < 0.01, `peak ${peak(ch)}`);
  assert.ok(Math.abs(lufs(ch, SR) + 20) < 0.1, `lufs ${lufs(ch, SR)}`);
});

test("the same sine in one channel only reads 3 LU lower", () => {
  const ch = [sine(997, 0.1, 5), new Float32Array(5 * SR)];
  assert.ok(Math.abs(lufs(ch, SR) + 23.01) < 0.1, `lufs ${lufs(ch, SR)}`);
});

test("K-weighting hears a low tone as quieter than a high one at the same level", () => {
  const low = lufs([sine(60, 0.1, 5), sine(60, 0.1, 5)], SR);
  const high = lufs([sine(3000, 0.1, 5), sine(3000, 0.1, 5)], SR);
  assert.ok(high - low > 5, `60 Hz ${low}, 3 kHz ${high}`);
});

test("power lands in the right band, and a phone loses the low one", () => {
  const mid = measure([sine(1000, 0.2, 3), sine(1000, 0.2, 3)], SR);
  assert.ok(mid.bands.mid > -0.1 && mid.bands.sub < -40, JSON.stringify(mid.bands));
  assert.ok(Math.abs(mid.centroid - 1000) < 30, `centroid ${mid.centroid}`);
  assert.ok(Math.abs(mid.corr - 1) < 0.001, "identical channels are fully correlated");
  const low = measure([sine(150, 0.2, 3), sine(150, 0.2, 3)], SR);
  assert.ok(low.bands.low > -0.1, JSON.stringify(low.bands));
  assert.ok(low.phone < -30, `a 150 Hz tone has nothing above 300 Hz, got ${low.phone}`);
});

test("silence then a burst is one onset, at the right time", () => {
  const x = new Float32Array(2 * SR);
  for (let i = SR; i < SR + 4800; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const found = onsets([x, x], SR);
  assert.equal(found.length, 1);
  assert.ok(Math.abs(found[0].t - 1) < 0.02, `at ${found[0].t}`);
});
