import "./style.css";
import { Sound } from "./audio";
import { Engine, W } from "./engine";
import { Knob } from "./knob";
import { SCALES, padSemis, voiceMidi } from "./scales";
import { Stage } from "./stage";

// ── clock: seconds that only pass while the page is visible ────────────────

const clock = {
  base: 0,
  mark: performance.now(),
  on: true,
  now() {
    return this.on ? this.base + (performance.now() - this.mark) / 1000 : this.base;
  },
  pause() {
    if (!this.on) return;
    this.base = this.now();
    this.on = false;
  },
  resume() {
    if (this.on) return;
    this.mark = performance.now();
    this.on = true;
  },
};

// ── state ──────────────────────────────────────────────────────────────────

const TEMPO = { min: 60, max: 150, start: 96 };
let scale = SCALES[0];
let selected = 1;
let tone = 0.5;
let touched = false;

let actx: AudioContext | null = null;
let sound: Sound | null = null;

const panOf = (pad: number) => ((pad % W) / (W - 1)) * 2 - 1;
const midiOf = (voice: number, pad: number) =>
  voiceMidi(voice, padSemis(pad % W, Math.floor(pad / W), scale));
/** clock seconds → audio context seconds */
const audioTime = (when: number) => actx!.currentTime + (when - clock.now());
const audible = () => sound !== null && actx !== null && actx.state === "running";

const engine = new Engine(
  {
    land(ball, pad, when, vel) {
      if (audible()) sound!.note(ball.id, midiOf(ball.id, pad), audioTime(when), vel, panOf(pad));
    },
    wall(_ball, when, power, x) {
      if (audible()) sound!.tick(audioTime(when), power, Math.max(-1, Math.min(1, (x / (W - 1)) * 2 - 1)));
    },
    home(_ball, when) {
      if (audible()) sound!.thud(audioTime(when), 0.7);
    },
  },
  3,
);
engine.setTempo(TEMPO.start, 0);

const stage = new Stage(engine);
stage.setScale(scale);
stage.select(selected);

// ── audio unlock ───────────────────────────────────────────────────────────
// Created on the first gesture. iOS only honours some event types as a
// gesture, so every plausible one tries to resume.

function wake() {
  if (!actx) {
    const AC: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    actx = new AC({ latencyHint: "interactive" });
    sound = new Sound(actx, engine.stepSeconds);
    sound.tone = tone;
    // one silent sample: older iOS only truly opens the output once something has played
    const blip = actx.createBufferSource();
    blip.buffer = actx.createBuffer(1, 1, actx.sampleRate);
    blip.connect(actx.destination);
    blip.start();
    try {
      // play even when the iPhone ring switch is on silent
      (navigator as unknown as { audioSession: { type: string } }).audioSession.type = "playback";
    } catch {
      /* not supported */
    }
  }
  if (actx.state !== "running") actx.resume().catch(() => {});
}
for (const type of ["pointerdown", "pointerup", "touchend", "click", "keydown"]) {
  window.addEventListener(type, wake, { capture: true, passive: true });
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clock.pause();
    actx?.suspend().catch(() => {});
  } else {
    clock.resume();
    if (touched) actx?.resume().catch(() => {});
  }
});

// ── playing ────────────────────────────────────────────────────────────────

const tag = document.getElementById("tag")!;
const playKey = document.getElementById("play")!;

function firstTouch() {
  if (touched) return;
  touched = true;
  tag.classList.add("gone");
  stage.ready();
}

/** a finger on a pad: it sounds now, and the selected ball heads there */
function strike(pad: number) {
  wake();
  firstTouch();
  sound?.note(selected, midiOf(selected, pad), 0, 0.92, panOf(pad));
  stage.aim(pad, selected);
  engine.tap(selected, pad, clock.now());
}

function select(id: number) {
  wake();
  firstTouch();
  const ball = engine.balls[id];
  if (id !== selected) {
    selected = id;
    stage.select(id);
    if (ball.mode === "home") audition(id);
    return;
  }
  if (ball.mode === "home") audition(id);
  else {
    engine.recall(id, clock.now());
    stage.aim(-1);
  }
}

function audition(id: number) {
  stage.nudge(id, clock.now());
  sound?.note(id, voiceMidi(id, 0), 0, 0.7, 0);
}

/** curated first throws: [low, mid, high] pads, picked so the three interlock */
const SERVES = [
  [4, 2, 11],
  [5, 1, 7],
  [10, 7, 2],
  [0, 11, 5],
  [6, 3, 9],
];
let lastServe = -1;

function togglePlay() {
  wake();
  firstTouch();
  const now = clock.now();
  if (engine.anyOut) {
    for (const b of engine.balls) engine.recall(b.id, now);
    stage.aim(-1);
    return;
  }
  let i = Math.floor(Math.random() * SERVES.length);
  if (i === lastServe) i = (i + 1) % SERVES.length;
  lastServe = i;
  const s = SERVES[i];
  engine.serve(1, s[1], now, 0);
  engine.serve(0, s[0], now, 4);
  engine.serve(2, s[2], now, 8);
}

// ── picking a ball up ──────────────────────────────────────────────────────
// A resting ball can be carried and thrown. The touch that lands on it still
// does its normal job (strike the pad, select the nest); it only becomes a
// carry once the finger has clearly moved.

const GRAB = { slop: 8, window: 90 }; // px before it counts as a drag; ms of motion kept for velocity

interface Grab {
  id: number;
  pointer: number;
  x: number;
  y: number;
  ox: number;
  oy: number;
  carrying: boolean;
  trail: { x: number; y: number; t: number }[];
}
let grab: Grab | null = null;

function grabStart(e: PointerEvent) {
  if (grab) return;
  const id = stage.ballAt(e.clientX, e.clientY);
  if (id < 0) return;
  const c = stage.ballPx(id);
  grab = {
    id,
    pointer: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    ox: e.clientX - c.x,
    oy: e.clientY - c.y,
    carrying: false,
    trail: [],
  };
}

/** @returns true if this pointer is carrying a ball (so nothing else should react) */
function grabMove(e: PointerEvent): boolean {
  if (!grab || grab.pointer !== e.pointerId) return false;
  if (!grab.carrying) {
    if (Math.hypot(e.clientX - grab.x, e.clientY - grab.y) < GRAB.slop) return false;
    grab.carrying = true;
    if (selected !== grab.id) {
      selected = grab.id;
      stage.select(selected);
    }
    stage.aim(-1);
    const pad = fingers.get(e.pointerId);
    if (pad !== undefined) {
      fingers.delete(e.pointerId);
      stage.press(pad, false);
    }
    // the ball stays under the same part of the finger that touched it
    engine.hold(grab.id, stage.cellAt(e.clientX - grab.ox, e.clientY - grab.oy));
  }
  engine.carry(grab.id, stage.cellAt(e.clientX - grab.ox, e.clientY - grab.oy));
  const t = performance.now();
  grab.trail.push({ x: e.clientX, y: e.clientY, t });
  while (grab.trail.length > 2 && t - grab.trail[0].t > GRAB.window) grab.trail.shift();
  return true;
}

function grabEnd(e: PointerEvent): boolean {
  if (!grab || grab.pointer !== e.pointerId) return false;
  const g = grab;
  grab = null;
  if (!g.carrying) return false;
  let vx = 0;
  let vy = 0;
  const t = performance.now();
  const a = g.trail[0];
  const b = g.trail[g.trail.length - 1];
  // a finger that stopped before lifting is a drop, not a throw
  if (a && b && b.t > a.t && t - b.t < 60) {
    vx = ((b.x - a.x) / (b.t - a.t)) * 1000;
    vy = ((b.y - a.y) / (b.t - a.t)) * 1000;
  }
  engine.release(g.id, clock.now(), { x: vx / stage.c, y: -vy / stage.c }, stage.letGo(g.id));
  return true;
}

// pads: multi-touch, and sliding across wells strums them
const fingers = new Map<number, number>();

stage.tray.addEventListener("pointerdown", (e) => {
  const pad = stage.padAt(e.clientX, e.clientY);
  if (pad < 0) return;
  e.preventDefault();
  stage.tray.setPointerCapture(e.pointerId);
  // touching a ball that is sitting on the tray makes it the one that listens
  const resting = stage.ballAt(e.clientX, e.clientY);
  if (resting >= 0 && resting !== selected) {
    selected = resting;
    stage.select(resting);
  }
  grabStart(e);
  fingers.set(e.pointerId, pad);
  stage.press(pad, true);
  strike(pad);
});
stage.tray.addEventListener("pointermove", (e) => {
  if (grabMove(e)) return;
  const was = fingers.get(e.pointerId);
  if (was === undefined) return;
  // only a deliberate arrival in another well counts
  const pad = stage.padAt(e.clientX, e.clientY, 0.36);
  if (pad < 0 || pad === was) return;
  stage.press(was, false);
  fingers.set(e.pointerId, pad);
  stage.press(pad, true);
  strike(pad);
});
const lift = (e: PointerEvent) => {
  grabEnd(e);
  const was = fingers.get(e.pointerId);
  if (was === undefined) return;
  fingers.delete(e.pointerId);
  if (![...fingers.values()].includes(was)) stage.press(was, false);
};
stage.tray.addEventListener("pointerup", lift);
stage.tray.addEventListener("pointercancel", lift);
// keyboard / switch activation of a focused pad
stage.tray.addEventListener("click", (e) => {
  if (e.detail !== 0) return;
  const el = (e.target as HTMLElement).closest<HTMLElement>(".pad");
  if (el) strike(Number(el.dataset.pad));
});

stage.homes.forEach((home, id) => {
  home.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    home.setPointerCapture(e.pointerId);
    grabStart(e);
    select(id);
  });
  home.addEventListener("pointermove", grabMove);
  home.addEventListener("pointerup", grabEnd);
  home.addEventListener("pointercancel", grabEnd);
  home.addEventListener("click", (e) => {
    if (e.detail === 0) select(id);
  });
});

playKey.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  togglePlay();
});
playKey.addEventListener("click", (e) => {
  if (e.detail === 0) togglePlay();
});

// ── knobs ──────────────────────────────────────────────────────────────────

const knobs = document.getElementById("knobs")!;
const bpmOf = (v: number) => Math.round(TEMPO.min + v * (TEMPO.max - TEMPO.min));
/** the last stretch of the knob is a detent: lossless, forever */
const bounceOf = (v: number) => (v >= 0.93 ? 1 : 0.45 + 0.5 * (v / 0.93));

new Knob(knobs, {
  label: "tempo",
  value: (TEMPO.start - TEMPO.min) / (TEMPO.max - TEMPO.min),
  format: (v) => String(bpmOf(v)),
  onChange: (v) => {
    engine.setTempo(bpmOf(v), clock.now());
    sound?.setStep(engine.stepSeconds);
  },
});
new Knob(knobs, {
  label: "bounce",
  value: 1,
  format: (v) => (bounceOf(v) >= 1 ? "∞" : String(Math.round(bounceOf(v) * 100))),
  onChange: (v) => {
    engine.bounce = bounceOf(v);
  },
});
new Knob(knobs, {
  label: "tone",
  value: tone,
  format: (v) => String(Math.round(v * 100)),
  onChange: (v) => {
    tone = v;
    if (sound) sound.tone = v;
  },
});
new Knob(knobs, {
  label: "scale",
  value: 0,
  steps: SCALES.length,
  format: (v) => SCALES[Math.round(v * (SCALES.length - 1))].name,
  onChange: (v) => {
    scale = SCALES[Math.round(v * (SCALES.length - 1))];
    stage.setScale(scale);
  },
});

// ── keyboard ───────────────────────────────────────────────────────────────

const KEYS = [
  ["KeyZ", "KeyX", "KeyC", "KeyV"],
  ["KeyA", "KeyS", "KeyD", "KeyF"],
  ["KeyQ", "KeyW", "KeyE", "KeyR"],
  ["Digit1", "Digit2", "Digit3", "Digit4"],
];
const keyPad = new Map<string, number>();
KEYS.forEach((row, r) => row.forEach((code, c) => keyPad.set(code, r * W + c)));
const BALL_KEYS = ["KeyJ", "KeyK", "KeyL"];

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const pad = keyPad.get(e.code);
  if (pad !== undefined) {
    if (e.repeat) return;
    stage.press(pad, true);
    strike(pad);
    e.preventDefault();
    return;
  }
  const ball = BALL_KEYS.indexOf(e.code);
  if (ball >= 0) {
    if (!e.repeat) select(ball);
    e.preventDefault();
    return;
  }
  if (e.code === "Space") {
    const el = document.activeElement;
    if (el instanceof HTMLButtonElement) el.blur();
    if (!e.repeat) togglePlay();
    e.preventDefault();
  } else if (e.code === "Backspace" || e.code === "Escape") {
    engine.recall(selected, clock.now());
  }
});
window.addEventListener("keyup", (e) => {
  const pad = keyPad.get(e.code);
  if (pad !== undefined) stage.press(pad, false);
});

// ── frame ──────────────────────────────────────────────────────────────────

let last = clock.now();
let lag = 0;

function frame() {
  const now = clock.now();
  const dt = Math.max(0, now - last);
  last = now;

  // hold the picture back by the output latency so a landing is seen when it is heard
  if (audible()) {
    const out = (actx as AudioContext & { outputLatency?: number }).outputLatency || actx!.baseLatency || 0;
    lag += (Math.min(0.3, Math.max(0, out)) - lag) * 0.05;
  }
  engine.lag = lag;
  engine.advance(now);
  stage.render(engine.stepAt(now - lag), now, dt);

  const out = engine.anyOut;
  if (out !== playing) {
    playing = out;
    playKey.classList.toggle("on", out);
    playKey.setAttribute("aria-pressed", String(out));
    playKey.setAttribute("aria-label", out ? "Stop" : "Play");
  }
  requestAnimationFrame(frame);
}
let playing = false;
requestAnimationFrame(frame);

// keep notes on time if a frame is ever late
setInterval(() => {
  if (!document.hidden) engine.advance(clock.now());
}, 40);

// no rubber-banding, no pinch zoom, no long-press menu on the hardware
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("gesturestart", (e) => e.preventDefault());
