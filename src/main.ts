import "./style.css";
import { Sound } from "./audio";
import { Engine, W } from "./engine";
import type { Throw } from "./engine";
import { Knob } from "./knob";
import { decode, encode } from "./link";
import type { Patch } from "./link";
import { SCALES, noteName, padSemis, rootShift, voiceMidi } from "./scales";
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
/** semitones above C, 0–11 */
let root = 0;
let selected = 1;
let tone = 0.5;
let touched = false;

let actx: AudioContext | null = null;
let sound: Sound | null = null;

const panOf = (pad: number) => ((pad % W) / (W - 1)) * 2 - 1;
const midiOf = (voice: number, pad: number) =>
  voiceMidi(voice, padSemis(pad % W, Math.floor(pad / W), scale)) + rootShift(root);
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
    hush(ball, when) {
      if (audible()) sound!.hush(ball.id, audioTime(when));
    },
  },
  3,
);
engine.setTempo(TEMPO.start, 0);

const stage = new Stage(engine);
stage.setScale(scale, root);
stage.select(selected);

// ── audio ──────────────────────────────────────────────────────────────────
// The graph is built at load, while nothing is happening, so a first touch
// has nothing to do but start it.
//
// A browser will not start audio on a touch screen until a finger *lifts*
// (touchend / pointerup are gestures; touchstart / pointerdown are not). So
// the very first note waits for that lift; from then on the context is
// running and every touch sounds on the way down.

const FRESH = 600; // ms a note asked for while locked is still worth playing once unlocked

interface Asked {
  voice: number;
  midi: number;
  pan: number;
  level: number;
  at: number;
}
let asked: Asked | null = null;
/** the output has really run at least once */
let opened = false;

function build() {
  if (actx) return;
  const AC: typeof AudioContext =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  try {
    actx = new AC({ latencyHint: "interactive" });
    sound = new Sound(actx, engine.stepSeconds);
    sound.tone = tone;
    actx.addEventListener("statechange", heard);
  } catch {
    actx = null;
    sound = null;
  }
}

/** the context has (re)started: play what the finger asked for while it could not */
function heard() {
  if (!audible()) return;
  opened = true;
  const a = asked;
  asked = null;
  if (a && performance.now() - a.at < FRESH) sound!.touch(a.voice, a.midi, 0, a.pan, a.level);
}

function wake() {
  build();
  if (!actx) return;
  if (!opened) {
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
  // "interrupted" (a call, Siri, the lock screen) needs the same nudge as "suspended"
  if (actx.state !== "running") actx.resume().then(heard, () => {});
  else heard();
}
for (const type of ["pointerdown", "pointerup", "touchend", "click", "keydown"]) {
  window.addEventListener(type, wake, { capture: true, passive: true });
}
build();

/**
 * A note from the hand: now if the audio is running, the moment it starts if
 * it is not. It is a touch, not a landing: quieter and shorter than the note
 * the ball will play when it gets there, so a tap is not heard twice.
 */
function play(voice: number, midi: number, pan: number, level = 1) {
  if (audible()) sound!.touch(voice, midi, 0, pan, level);
  else asked = { voice, midi, pan, level, at: performance.now() };
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
const device = document.getElementById("device")!;

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
  play(selected, midiOf(selected, pad), panOf(pad));
  own = true;
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
  // nothing lands after this one, so it speaks up a little
  play(id, voiceMidi(id, 0) + rootShift(root), 0, 1.4);
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

/** the last thing the balls were doing, kept after they are called home so the key can serve it again */
let pattern: (Throw | null)[] | null = null;
/** the player made it (or was sent it); a serve of ours that nobody touched is not worth repeating */
let own = false;

function togglePlay() {
  wake();
  firstTouch();
  const now = clock.now();
  if (engine.anyOut) {
    for (const b of engine.balls) engine.recall(b.id, now);
    stage.aim(-1);
    return;
  }
  if (pattern && own) {
    engine.restore(pattern, now);
    return;
  }
  own = false;
  let i = Math.floor(Math.random() * SERVES.length);
  if (i === lastServe) i = (i + 1) % SERVES.length;
  lastServe = i;
  const s = SERVES[i];
  engine.serve(1, s[1], now, 0);
  engine.serve(0, s[0], now, 4);
  engine.serve(2, s[2], now, 8);
}

// ── a ball in the hand ─────────────────────────────────────────────────────
// A ball sitting still can be picked up: the touch that lands on it still
// does its normal job (strike the pad, select the nest) and only becomes a
// carry once the finger has clearly moved.
//
// A ball in the air is caught: it stops under the finger at once, with a
// soft pat instead of a note. Either way, letting go drops it or throws it.

const GRAB = { slop: 8, window: 90 }; // px before it counts as a drag; ms of motion kept for velocity

interface Grab {
  id: number;
  x: number;
  y: number;
  ox: number;
  oy: number;
  carrying: boolean;
  trail: { x: number; y: number; t: number }[];
}
/** one per finger, so two hands can hold two balls */
const grabs = new Map<number, Grab>();

/** the ball leaves the tray for the hand */
function take(g: Grab, e: PointerEvent) {
  g.carrying = true;
  if (selected !== g.id) {
    selected = g.id;
    stage.select(selected);
  }
  stage.unaim(g.id);
  const pad = fingers.get(e.pointerId);
  if (pad !== undefined) {
    fingers.delete(e.pointerId);
    if (![...fingers.values()].includes(pad)) stage.press(pad, false);
  }
  stage.take(g.id);
  // the ball stays under the same part of the finger that touched it
  engine.hold(g.id, stage.cellAt(e.clientX - g.ox, e.clientY - g.oy));
}

/** @returns true if the touch caught a ball out of the air (so it is not a tap on what is under it) */
function grabStart(e: PointerEvent): boolean {
  // a finger already carrying a ball has its hand full (anything else left under this id is stale)
  if (grabs.get(e.pointerId)?.carrying) return false;
  grabs.delete(e.pointerId);
  const id = stage.ballAt(e.clientX, e.clientY, e.pointerType === "touch");
  if (id < 0) return false;
  for (const g of grabs.values()) if (g.id === id) return false;
  const c = stage.ballPx(id);
  const g: Grab = {
    id,
    x: e.clientX,
    y: e.clientY,
    ox: e.clientX - c.x,
    oy: e.clientY - c.y,
    carrying: false,
    trail: [],
  };
  grabs.set(e.pointerId, g);
  if (engine.balls[id].mode !== "fly") return false;
  wake();
  firstTouch();
  take(g, e);
  if (audible()) sound!.pat(id, 0.8);
  return true;
}

function grabMove(e: PointerEvent) {
  const g = grabs.get(e.pointerId);
  if (!g) return;
  if (!g.carrying) {
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < GRAB.slop) return;
    take(g, e);
  }
  engine.carry(g.id, stage.cellAt(e.clientX - g.ox, e.clientY - g.oy));
  const t = performance.now();
  g.trail.push({ x: e.clientX, y: e.clientY, t });
  while (g.trail.length > 2 && t - g.trail[0].t > GRAB.window) g.trail.shift();
}

function grabEnd(e: PointerEvent) {
  const g = grabs.get(e.pointerId);
  if (!g) return;
  grabs.delete(e.pointerId);
  if (!g.carrying) return;
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
  own = true;
}

/** is this finger carrying a ball (so nothing else should react to it)? */
const carrying = (e: PointerEvent) => grabs.get(e.pointerId)?.carrying === true;

// One place follows every hand, ahead of the handlers on the things beneath it.
window.addEventListener("pointermove", grabMove, true);
window.addEventListener("pointerup", grabEnd, true);
window.addEventListener("pointercancel", grabEnd, true);

// pads: multi-touch, and sliding across wells strums them
const fingers = new Map<number, number>();

stage.tray.addEventListener("pointerdown", (e) => {
  const pad = stage.padAt(e.clientX, e.clientY);
  const over = stage.ballAt(e.clientX, e.clientY, e.pointerType === "touch");
  if (pad < 0 && over < 0) return;
  e.preventDefault();
  stage.tray.setPointerCapture(e.pointerId);
  if (grabStart(e)) return;
  // touching a ball that is sitting on the tray makes it the one that listens
  if (over >= 0 && over !== selected) {
    selected = over;
    stage.select(over);
  }
  if (pad < 0) return;
  fingers.set(e.pointerId, pad);
  stage.press(pad, true);
  strike(pad);
});
stage.tray.addEventListener("pointermove", (e) => {
  if (carrying(e)) return;
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
    if (grabStart(e)) return;
    select(id);
  });
  home.addEventListener("click", (e) => {
    if (e.detail === 0) select(id);
  });
});

// a ball crossing the bare slab (on its way home, say) can be caught there too
device.addEventListener("pointerdown", (e) => {
  if ((e.target as Element).closest(".tray, .home, .play, .knob")) return;
  if (stage.ballAt(e.clientX, e.clientY, e.pointerType === "touch") < 0) return;
  if (!grabStart(e)) {
    grabs.delete(e.pointerId);
    return;
  }
  e.preventDefault();
  device.setPointerCapture(e.pointerId);
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
let echoTimer = 0;
const bpmOf = (v: number) => Math.round(TEMPO.min + v * (TEMPO.max - TEMPO.min));
/** the last stretch of the knob is a detent: lossless, forever */
const bounceOf = (v: number) => (v >= 0.93 ? 1 : 0.45 + 0.5 * (v / 0.93));

const tempoKnob = new Knob(knobs, {
  label: "tempo",
  value: (TEMPO.start - TEMPO.min) / (TEMPO.max - TEMPO.min),
  format: (v) => String(bpmOf(v)),
  onChange: (v) => {
    engine.setTempo(bpmOf(v), clock.now());
    // the echo follows once the knob has come to rest (see Sound.setStep)
    clearTimeout(echoTimer);
    echoTimer = window.setTimeout(() => sound?.setStep(engine.stepSeconds), 180);
  },
});
const bounceKnob = new Knob(knobs, {
  label: "bounce",
  value: 1,
  format: (v) => (bounceOf(v) >= 1 ? "∞" : String(Math.round(bounceOf(v) * 100))),
  onChange: (v) => {
    engine.bounce = bounceOf(v);
  },
});
const toneKnob = new Knob(knobs, {
  label: "tone",
  value: tone,
  format: (v) => String(Math.round(v * 100)),
  onChange: (v) => {
    tone = v;
    if (sound) sound.tone = v;
  },
});
// Turn it for the scale; push it, like an encoder, to step the root up a semitone.
const scaleKnob: Knob = new Knob(knobs, {
  label: "scale",
  value: 0,
  steps: SCALES.length,
  format: (v) => SCALES[Math.round(v * (SCALES.length - 1))].name,
  onChange: (v) => {
    scale = SCALES[Math.round(v * (SCALES.length - 1))];
    stage.setScale(scale, root);
  },
  onPush: () => {
    wake();
    setRoot((root + 1) % 12);
    scaleKnob.say("root " + noteName(root));
    // hear where it has gone: the listening ball's voice, on the new root
    play(selected, voiceMidi(selected, 0) + rootShift(root), 0, 1.4);
  },
});

function setRoot(r: number) {
  root = r;
  stage.setScale(scale, root);
}

// ── the link ───────────────────────────────────────────────────────────────
// The address always says what is playing: the four knobs, the root, and the
// course each ball is on. Reloading it, or opening it somewhere else, sets
// the knobs and leaves the balls in their nests; the key serves them.

const BLANK = encode({ tempo: TEMPO.start, bounce: 100, tone: 50, scale: 0, root: 0, throws: [null, null, null] });

const patch = (): Patch => ({
  tempo: bpmOf(tempoKnob.value),
  bounce: Math.round(bounceKnob.value * 100),
  tone: Math.round(toneKnob.value * 100),
  scale: SCALES.indexOf(scale),
  root,
  throws: pattern ?? [null, null, null],
});

function apply(p: Patch) {
  tempoKnob.set((p.tempo - TEMPO.min) / (TEMPO.max - TEMPO.min), false);
  bounceKnob.set(p.bounce / 100, false);
  toneKnob.set(p.tone / 100, false);
  scaleKnob.set(p.scale / (SCALES.length - 1), false);
  setRoot(p.root);
  pattern = p.throws.some(Boolean) ? p.throws : null;
  own = pattern !== null;
}

let seen = BLANK;
let written = BLANK;

/** keep the address up to date, once what it would say has held still for a moment */
function sync(now = false) {
  const snap = engine.snapshot();
  if (snap.some(Boolean)) pattern = snap;
  const token = encode(patch());
  if (token !== seen && !now) {
    seen = token;
    return;
  }
  seen = token;
  if (token === written) return;
  written = token;
  try {
    history.replaceState(null, "", token === BLANK ? location.pathname + location.search : "#" + token);
  } catch {
    /* some browsers ration this; the next change will try again */
  }
}

function openLink(hash: string) {
  const p = decode(hash, SCALES.length);
  if (!p) return false;
  const now = clock.now();
  for (const b of engine.balls) engine.recall(b.id, now);
  stage.aim(-1);
  apply(p);
  seen = written = encode(p);
  return true;
}

if (openLink(location.hash) && pattern) tag.textContent = "press play";
setInterval(() => sync(), 300);
window.addEventListener("hashchange", () => {
  if (location.hash.replace(/^#/, "") !== written) openLink(location.hash);
});

const linkKey = document.getElementById("link")!;
const linkSays = linkKey.querySelector<HTMLElement>(".link-val")!;
let linkTimer = 0;

function linkSay(text: string) {
  linkSays.textContent = text;
  linkKey.classList.add("show");
  clearTimeout(linkTimer);
  linkTimer = window.setTimeout(() => linkKey.classList.remove("show"), 1100);
}

// a click, not a press: sharing and the clipboard are only allowed once a finger has lifted
linkKey.addEventListener("click", async () => {
  sync(true);
  const url = location.href;
  if (matchMedia("(pointer: coarse)").matches && typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "bop", url });
    } catch {
      /* closed without sharing */
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    linkSay("copied");
  } catch {
    // no clipboard here: it is in the address bar all the same
    linkSay("in url");
  }
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
