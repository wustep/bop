/**
 * Fuzz the bounce engine: hundreds of random sessions of taps, recalls,
 * pick-ups, throws and knob turns, checking the things that must never
 * break no matter what a player does.
 *
 *   pnpm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, H, W } from "../src/engine.ts";
import type { Pose } from "../src/engine.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

interface Report {
  landings: number;
  badPads: number;
  notFinite: number;
  belowFloor: number;
  throughWall: number;
  offGrid: number;
}

function session(seed: number, lossless: boolean, report: Report) {
  const rnd = rng(seed);
  const e = new Engine(
    {
      land(_b, pad) {
        report.landings++;
        if (!Number.isInteger(pad) || pad < 0 || pad >= W * H) report.badPads++;
      },
      wall() {},
      home() {},
    },
    3,
  );
  e.setTempo(60 + Math.floor(rnd() * 90), 0);
  e.bounce = lossless ? 1 : 0.45 + rnd() * 0.5;
  e.balls.forEach((b, i) => {
    e.setHome(i, { x: i, y: -1.3 });
    b.edge = [0.41, 0.48, 0.54][i];
  });

  const pose: Pose = { x: 0, y: 0, z: 0 };
  let next = 0.2;
  for (let t = 0; t < 14; t += 1 / 60) {
    if (t >= next) {
      next = t + 0.15 + rnd() * 1.6;
      const id = Math.floor(rnd() * 3);
      const r = rnd();
      const mode = e.balls[id].mode;
      if (r < 0.62) e.tap(id, Math.floor(rnd() * 16), t);
      else if (r < 0.72) e.recall(id, t);
      else if (r < 0.9 && (mode === "home" || mode === "rest")) {
        e.hold(id, { x: rnd() * 6 - 1.5, y: rnd() * 7 - 2 });
        const still = rnd() < 0.4;
        e.release(id, t, still ? { x: 0, y: 0 } : { x: (rnd() - 0.5) * 40, y: (rnd() - 0.5) * 40 }, 0.5);
      } else if (!lossless) e.bounce = 0.45 + rnd() * 0.5;
    }
    e.advance(t);

    if (lossless) {
      const flying = e.balls.filter((b) => b.mode === "fly" && b.hop && b.hop.pad >= 0);
      for (let i = 0; i < flying.length; i++) {
        for (let j = i + 1; j < flying.length; j++) {
          const d = flying[i].hop!.t1 - flying[j].hop!.t1;
          if (Math.abs(d - Math.round(d)) > 1e-6) report.offGrid++;
        }
      }
    }

    const s = e.stepAt(t);
    for (const b of e.balls) {
      e.pose(b, s, pose);
      if (![pose.x, pose.y, pose.z].every(Number.isFinite)) report.notFinite++;
      if (pose.z < -1e-9) report.belowFloor++;
      const hop = b.hop;
      if (b.mode === "fly" && hop && !hop.free && s >= hop.t0) {
        const over = Math.max(
          -b.edge - pose.x,
          pose.x - (W - 1 + b.edge),
          -b.edge - pose.y,
          pose.y - (H - 1 + b.edge),
        );
        if (over > 1e-9) report.throughWall++;
      }
      b.fx.length = 0;
    }
  }
}

test("400 random sessions never break the physics", () => {
  const report: Report = { landings: 0, badPads: 0, notFinite: 0, belowFloor: 0, throughWall: 0, offGrid: 0 };
  for (let i = 0; i < 400; i++) session(1000 + i, i % 2 === 0, report);
  assert.ok(report.landings > 10000, `expected plenty of landings, got ${report.landings}`);
  assert.equal(report.badPads, 0, "every landing is on a real pad");
  assert.equal(report.notFinite, 0, "positions are always finite");
  assert.equal(report.belowFloor, 0, "a ball never sinks below the surface");
  assert.equal(report.throughWall, 0, "a ball inside the tray never passes a wall");
  assert.equal(report.offGrid, 0, "lossless balls in flight together share one grid");
});

test("a lossless throw loops, and a far throw is a slow one", () => {
  const lands: [number, number][] = [];
  const e = new Engine({ land: (_b, pad, when) => lands.push([when, pad]), wall() {}, home() {} }, 1);
  e.setTempo(96, 0);
  e.setHome(0, { x: 1, y: -1 });
  e.tap(0, 6, 0); // from (1,-1) to (2,1): stride (1,2), so a landing every 2 steps
  for (let t = 0; t < 12; t += 1 / 120) e.advance(t);
  const pads = lands.map((l) => l[1]);
  assert.deepEqual(pads.slice(0, 8), pads.slice(8, 16), "the path repeats every 8 hops");
  const S = e.stepSeconds;
  for (let i = 1; i < 12; i++) {
    assert.ok(Math.abs((lands[i][0] - lands[i - 1][0]) / S - 2) < 1e-9, "each hop takes 2 steps");
  }
});

test("with bounce below 1 the ball speeds up, quietens down, and comes to rest", () => {
  const lands: [number, number][] = [];
  const e = new Engine({ land: (_b, _pad, when, vel) => lands.push([when, vel]), wall() {}, home() {} }, 1);
  e.setTempo(96, 0);
  e.bounce = 0.7;
  e.setHome(0, { x: 1, y: -1 });
  e.tap(0, 11, 0);
  for (let t = 0; t < 12; t += 1 / 120) e.advance(t);
  assert.equal(e.balls[0].mode, "rest");
  assert.ok(lands.length >= 5 && lands.length < 30);
  for (let i = 2; i < lands.length; i++) {
    const gap = lands[i][0] - lands[i - 1][0];
    const before = lands[i - 1][0] - lands[i - 2][0];
    assert.ok(gap < before, "each gap is shorter than the last");
    assert.ok(lands[i][1] <= lands[i - 1][1], "each landing is no louder than the last");
  }
});
