/**
 * Offline renders of scripted sessions, for judging the sound by measurement.
 *
 * A Session is the real bounce engine wired to the real Sound, exactly as
 * main.ts wires them, but on an OfflineAudioContext with a clock that is
 * simply the audio time. A scene is a script of what a player does.
 *
 *   pnpm dev, then open /tools/render.html
 *   or, from a console / an automation script:  await bop.render("play")
 */

import { Sound } from "../src/audio";
import { Engine, W } from "../src/engine";
import { SCALES, padSemis, voiceMidi } from "../src/scales";
import type { Scale } from "../src/scales";
import { measure, onsets } from "./meter";
import type { Stats } from "./meter";

export const SR = 48000;

/** leave out the notes or the knocks, or listen to one return alone */
type Only = "all" | "notes" | "knocks" | "dry" | "echo" | "room";

export class Session {
  readonly engine: Engine;
  readonly sound: Sound;
  scale: Scale = SCALES[0];
  only: Only = "all";
  private acts: { t: number; run: () => void }[] = [];

  constructor(readonly ctx: OfflineAudioContext, bpm = 96) {
    this.engine = new Engine(
      {
        land: (ball, pad, when, vel) => {
          if (this.only !== "knocks") this.sound.note(ball.id, this.midi(ball.id, pad), when, vel, this.pan(pad));
        },
        wall: (_ball, when, power, x) => {
          if (this.only !== "notes") this.sound.tick(when, power, Math.max(-1, Math.min(1, (x / (W - 1)) * 2 - 1)));
        },
        home: (_ball, when) => {
          if (this.only !== "notes") this.sound.thud(when, 0.7);
        },
        hush: (ball, when) => this.sound.hush(ball.id, when),
      },
      3,
    );
    this.engine.setTempo(bpm, 0);
    this.engine.balls.forEach((b, i) => {
      this.engine.setHome(i, { x: i, y: -1.3 });
      b.edge = [0.41, 0.48, 0.54][i];
    });
    this.sound = new Sound(ctx, this.engine.stepSeconds);
  }

  pan(pad: number) {
    return ((pad % W) / (W - 1)) * 2 - 1;
  }
  midi(voice: number, pad: number) {
    return voiceMidi(voice, padSemis(pad % W, Math.floor(pad / W), this.scale));
  }

  at(t: number, run: () => void) {
    this.acts.push({ t, run });
    return this;
  }

  /** a finger on a pad: it sounds, and the ball heads there */
  tap(t: number, ball: number, pad: number) {
    return this.at(t, () => {
      if (this.only !== "knocks") this.sound.touch(ball, this.midi(ball, pad), t, this.pan(pad));
      this.engine.tap(ball, pad, t);
    });
  }

  /** the play key: mid, then low a beat later, then high */
  serve(t: number, pads: [number, number, number]) {
    return this.at(t, () => {
      this.engine.serve(1, pads[1], t, 0);
      this.engine.serve(0, pads[0], t, 4);
      this.engine.serve(2, pads[2], t, 8);
    });
  }

  recall(t: number, ball: number) {
    return this.at(t, () => this.engine.recall(ball, t));
  }

  tempo(t: number, bpm: number) {
    return this.at(t, () => {
      this.engine.setTempo(bpm, t);
      this.sound.setStep(this.engine.stepSeconds, t);
    });
  }

  /** knob positions, 0..1, as main.ts maps them */
  bounce(t: number, v: number) {
    return this.at(t, () => (this.engine.bounce = v >= 0.93 ? 1 : 0.45 + 0.5 * (v / 0.93)));
  }
  tone(t: number, v: number) {
    return this.at(t, () => (this.sound.tone = v));
  }

  /** run the script against the engine, then render what it scheduled */
  async run(seconds: number): Promise<AudioBuffer> {
    this.acts.sort((a, b) => a.t - b.t);
    let next = 0;
    for (let t = 0; t < seconds; t += 0.01) {
      while (next < this.acts.length && this.acts[next].t <= t) this.acts[next++].run();
      this.engine.advance(t);
      for (const b of this.engine.balls) b.fx.length = 0;
    }
    return this.ctx.startRendering();
  }
}

export interface Scene {
  about: string;
  seconds: number;
  bpm?: number;
  script: (s: Session) => void;
}

/** every pad once, bottom-left to top-right, one voice alone */
const solo = (voice: number, tone: number): Scene => ({
  about: `${["lo", "mid", "hi"][voice]} alone, all sixteen pads, tone ${tone}`,
  seconds: 9,
  script: (s) => {
    s.tone(0, tone);
    for (let pad = 0; pad < 16; pad++) {
      const t = 0.2 + pad * 0.5;
      s.at(t, () => s.sound.note(voice, s.midi(voice, pad), t, 0.9, s.pan(pad)));
    }
  },
});

export const SCENES: Record<string, Scene> = {
  play: {
    about: "the play key, as a first visitor hears it: 96 bpm, three balls, 16 s",
    seconds: 16,
    script: (s) => s.serve(0.25, [4, 2, 11]),
  },
  busy: {
    about: "worst case for headroom: 150 bpm, tone at the top, three balls and a hand tapping",
    seconds: 12,
    bpm: 150,
    script: (s) => {
      s.tone(0, 1).serve(0.2, [10, 7, 2]);
      for (let i = 0; i < 20; i++) s.tap(2 + i * 0.4, i % 3, (i * 7 + 3) % 16);
    },
  },
  taps: {
    about: "a finger tapping a ball from well to well at 150 bpm (bounce low, so each tap is one hop)",
    seconds: 5,
    bpm: 150,
    script: (s) => {
      s.bounce(0, 0);
      s.tap(0.3, 1, 5);
      for (let i = 0; i < 6; i++) s.tap(1 + i * 0.6, 1, i % 2 ? 5 : 6);
    },
  },
  tempo: {
    about: "one note ringing in the echo while the tempo knob is flicked 96 → 150 → 70",
    seconds: 6,
    script: (s) => {
      s.at(0.2, () => s.sound.note(1, 72, 0.2, 0.9, 0));
      s.tempo(0.9, 150).tempo(2.4, 70);
    },
  },
  rattle: {
    about: "bounce at 70: three balls dropped in, speeding up and coming to rest",
    seconds: 8,
    script: (s) => {
      s.bounce(0, 0.5);
      s.tap(0.2, 1, 14).tap(0.5, 0, 9).tap(0.8, 2, 7);
      s.tap(4, 1, 3).tap(4.2, 2, 12);
    },
  },
  "timing-ball": {
    about: "one landing asked for at 0.500 s: when is it heard?",
    seconds: 1.5,
    script: (s) => s.at(0, () => s.sound.note(1, 72, 0.5, 0.9, 0)),
  },
  "timing-hand": {
    about: "one touch asked for at 0.500 s: when is it heard?",
    seconds: 1.5,
    script: (s) => s.at(0, () => s.sound.touch(1, 72, 0.5, 0)),
  },
  hand: {
    about: "what a hand does: a touch on each voice, then a catch of each ball",
    seconds: 5,
    script: (s) => {
      for (let v = 0; v < 3; v++) {
        s.at(0, () => s.sound.touch(v, s.midi(v, 5), 0.2 + v * 0.7, 0));
        s.at(0, () => s.sound.pat(v, 0.8, 2.6 + v * 0.7));
      }
    },
  },
  "solo-lo": solo(0, 0.5),
  "solo-mid": solo(1, 0.5),
  "solo-hi": solo(2, 0.5),
  "solo-lo-soft": solo(0, 0),
  "solo-mid-soft": solo(1, 0),
  "solo-hi-soft": solo(2, 0),
  "solo-lo-bright": solo(0, 1),
  "solo-mid-bright": solo(1, 1),
  "solo-hi-bright": solo(2, 1),
};

export interface Render {
  name: string;
  about: string;
  channels: Float32Array[];
  stats: Stats;
  onsets: { t: number; level: number }[];
}

export async function render(name: string, only: Only = "all"): Promise<Render> {
  const scene = SCENES[name];
  if (!scene) throw new Error(`no scene called ${name}`);
  const ctx = new OfflineAudioContext(2, Math.round(scene.seconds * SR), SR);
  const s = new Session(ctx, scene.bpm);
  s.only = only;
  if (only === "dry" || only === "echo" || only === "room") {
    for (const [name, node] of Object.entries(s.sound.returns)) if (name !== only) node.gain.value = 0;
  }
  scene.script(s);
  const buf = await s.run(scene.seconds);
  const channels = [buf.getChannelData(0), buf.getChannelData(1)];
  return { name, about: scene.about, channels, stats: measure(channels, SR), onsets: onsets(channels, SR) };
}

/** 32-bit float WAV */
export function wav(channels: Float32Array[], sr = SR): Uint8Array {
  const n = channels[0].length;
  const bytes = new Uint8Array(44 + n * channels.length * 4);
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + n * channels.length * 4, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true);
  v.setUint16(22, channels.length, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * channels.length * 4, true);
  v.setUint16(32, channels.length * 4, true);
  v.setUint16(34, 32, true);
  text(36, "data");
  v.setUint32(40, n * channels.length * 4, true);
  let at = 44;
  for (let i = 0; i < n; i++) for (const c of channels) (v.setFloat32(at, c[i], true), (at += 4));
  return bytes;
}

declare global {
  interface Window {
    bop: { render: typeof render; wav: typeof wav; SCENES: typeof SCENES };
  }
}
if (typeof window !== "undefined") window.bop = { render, wav, SCENES };
