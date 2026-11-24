/**
 * Sound. Three small FM voices (one per ball), a tempo-synced ping-pong
 * echo, a generated room, and a soft limiter. No samples.
 *
 * Everything is built against BaseAudioContext so the same graph renders in
 * an OfflineAudioContext, which is how it is judged: see tools/render.ts.
 *
 *   ball → strip ─┬─ dry ───────────────┐
 *                 ├─ echo ─┬────────────┤
 *                 └─ room ←┘ ───────────┴→ sum → leveller → makeup ─┬→ clip → out
 *   hand ───────────────────────────────────────────────────────────┘
 *
 * What a ball does goes through the leveller, which looks 6 ms ahead; those
 * sounds are known in advance, so they are simply started 6 ms early. What a
 * hand does (the note under a finger, the pat of a catch) cannot be known in
 * advance, so it joins after the leveller and is heard at once.
 *
 * Click-free rules used throughout:
 *   - every gain starts at 0 and ramps up over >= 1.5 ms
 *   - every gain ends on an exponential ramp to -60 dB, then a linear ramp to 0
 *   - voices are never stopped early; stealing fades a separate "kill" gain
 */

export const LO = 0;
export const MID = 1;
export const HI = 2;

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** deterministic noise so the room and the knocks sound the same every load */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Live {
  kill: GainNode;
  start: number;
  end: number;
}

/** the leveller's lookahead, seconds: scheduled sounds start this much early */
const AHEAD = 0.006;
/** gain after the leveller; set by measuring offline renders */
const MAKEUP = 1.22;

const STRIPS = [
  // dry, echo send, room send, max voices, highpass (Hz)
  { dry: 0.95, echo: 0.0, room: 0.05, max: 3, hp: 50 },
  { dry: 0.8, echo: 0.2, room: 0.2, max: 10, hp: 110 },
  { dry: 0.6, echo: 0.3, room: 0.26, max: 8, hp: 320 },
];

/** the note under a finger: level, and how much of the full note's ring it keeps */
const TOUCH = { vel: 0.5, ring: 0.5, gain: 1.9, room: 0.12 };

interface EchoUnit {
  input: GainNode;
  output: GainNode;
  left: DelayNode;
  right: DelayNode;
}

export class Sound {
  readonly ctx: BaseAudioContext;
  /** 0 = soft and short, 1 = bright and ringing */
  tone = 0.5;
  /** the three returns, exposed so a render can solo one */
  readonly returns: { dry: GainNode; echo: GainNode; room: GainNode };

  private strips: GainNode[] = [];
  private hands: GainNode[] = [];
  private live: Live[][] = [[], [], []];
  private noise: AudioBuffer;
  private echoes: EchoUnit[] = [];
  private echo = 0;
  private echoSeconds: number;

  constructor(ctx: BaseAudioContext, stepSeconds: number) {
    this.ctx = ctx;

    // ── master: sum → leveller → makeup → soft clip → out ──
    const sum = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.16;
    const makeup = ctx.createGain();
    makeup.gain.value = MAKEUP;
    // transparent below 0.6, then a rounded shoulder: a safety net, not a sound
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(2049);
    const knee = 0.6;
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      const a = Math.abs(x);
      const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
      curve[i] = Math.sign(x) * y;
    }
    clip.curve = curve;
    sum.connect(comp).connect(makeup).connect(clip).connect(ctx.destination);
    // the hand's own sounds skip the leveller and its lookahead
    const hand = ctx.createGain();
    hand.gain.value = TOUCH.gain;
    hand.connect(clip);

    const dry = ctx.createGain();
    const echoOut = ctx.createGain();
    const roomOut = ctx.createGain();
    roomOut.gain.value = 0.9;
    dry.connect(sum);
    echoOut.connect(sum);
    roomOut.connect(sum);
    this.returns = { dry, echo: echoOut, room: roomOut };

    // ── room: convolver with a generated tail; nothing below 150 Hz goes in ──
    const roomIn = ctx.createBiquadFilter();
    roomIn.type = "highpass";
    roomIn.frequency.value = 150;
    roomIn.Q.value = 0.6;
    const room = ctx.createConvolver();
    room.buffer = this.makeRoom(2.4, 0.34);
    roomIn.connect(room).connect(roomOut);

    // ── echo: ping-pong, darkening on each repeat ──
    // Two identical units. Changing a delay's time while it rings bends the
    // pitch of everything in it, so the time is never changed on a unit that
    // is being listened to: see setStep().
    const echoIn = ctx.createGain();
    // a little of the echo goes to the room so repeats sit back
    const echoToRoom = ctx.createGain();
    echoToRoom.gain.value = 0.25;
    echoToRoom.connect(roomIn);
    this.echoSeconds = this.echoTime(stepSeconds);
    for (let i = 0; i < 2; i++) {
      const input = ctx.createGain();
      input.gain.value = i === 0 ? 1 : 0;
      const output = ctx.createGain();
      const left = ctx.createDelay(2);
      const right = ctx.createDelay(2);
      left.delayTime.value = right.delayTime.value = this.echoSeconds;
      const fbL = ctx.createGain();
      const fbR = ctx.createGain();
      fbL.gain.value = fbR.gain.value = 0.36;
      const dampL = ctx.createBiquadFilter();
      const dampR = ctx.createBiquadFilter();
      dampL.type = dampR.type = "lowpass";
      dampL.frequency.value = dampR.frequency.value = 2600;
      const panL = ctx.createStereoPanner();
      const panR = ctx.createStereoPanner();
      panL.pan.value = -0.55;
      panR.pan.value = 0.55;
      echoIn.connect(input).connect(left);
      left.connect(dampL).connect(fbL).connect(right);
      right.connect(dampR).connect(fbR).connect(left);
      left.connect(panL).connect(output);
      right.connect(panR).connect(output);
      output.connect(echoOut);
      output.connect(echoToRoom);
      this.echoes.push({ input, output, left, right });
    }

    // ── one channel strip per ball, and a lighter one for the hand ──
    for (const s of STRIPS) {
      const input = ctx.createGain();
      // FM at a 1:1 ratio leaves a DC term that follows the envelope: an
      // inaudible thump that eats headroom. Each voice loses what is under it.
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = s.hp;
      hp.Q.value = 0.6;
      input.connect(hp);
      const d = ctx.createGain();
      d.gain.value = s.dry;
      hp.connect(d).connect(dry);
      if (s.echo > 0) {
        const e = ctx.createGain();
        e.gain.value = s.echo;
        hp.connect(e).connect(echoIn);
      }
      const r = ctx.createGain();
      r.gain.value = s.room;
      hp.connect(r).connect(roomIn);
      this.strips.push(input);

      const touch = ctx.createGain();
      const thp = ctx.createBiquadFilter();
      thp.type = "highpass";
      thp.frequency.value = s.hp;
      thp.Q.value = 0.6;
      touch.connect(thp).connect(hand);
      const tr = ctx.createGain();
      tr.gain.value = TOUCH.room;
      thp.connect(tr).connect(roomIn);
      this.hands.push(touch);
    }

    // ── shared noise for knocks and ticks ──
    const n = Math.floor(ctx.sampleRate * 0.25);
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    const r = rng(7);
    for (let i = 0; i < n; i++) d[i] = r() * 2 - 1;
  }

  private makeRoom(seconds: number, tau: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const r = rng(ch ? 1234567 : 7654321);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        // the tail loses its top end as it decays, like a soft room
        const a = 0.07 + 0.45 * Math.exp(-t / 0.5);
        lp += a * (r() * 2 - 1 - lp);
        const fadeIn = 1 - Math.exp(-t / 0.006);
        const fadeOut = Math.min(1, (seconds - t) / 0.2);
        d[i] = lp * Math.exp(-t / tau) * fadeIn * fadeOut;
      }
    }
    return buf;
  }

  /** a dotted eighth */
  private echoTime(stepSeconds: number) {
    return Math.min(1.9, stepSeconds * 3);
  }

  /**
   * The tempo changed, so the echo should repeat at the new step.
   *
   * The unit that is ringing is left alone: it stops listening and its tail
   * dies away at the tempo it was played at. The idle unit is closed for a
   * few milliseconds, retimed while nothing can be heard through it, and
   * takes over. Call this once a tempo change has settled, not on every
   * movement of the knob.
   */
  setStep(stepSeconds: number, at = this.ctx.currentTime) {
    const v = this.echoTime(stepSeconds);
    if (Math.abs(v - this.echoSeconds) < 1e-4) return;
    this.echoSeconds = v;
    const old = this.echoes[this.echo];
    this.echo = 1 - this.echo;
    const next = this.echoes[this.echo];
    // anything still pending from an earlier change gives way to this one
    for (const p of [old.input.gain, next.input.gain, next.output.gain, next.left.delayTime, next.right.delayTime]) {
      p.cancelScheduledValues(at);
    }
    old.input.gain.setTargetAtTime(0, at, 0.008);
    next.output.gain.setTargetAtTime(0, at, 0.004);
    next.left.delayTime.setValueAtTime(v, at + 0.03);
    next.right.delayTime.setValueAtTime(v, at + 0.03);
    next.output.gain.setTargetAtTime(1, at + 0.035, 0.008);
    next.input.gain.setTargetAtTime(1, at + 0.035, 0.008);
  }

  /** shared envelope: 0 → peak → -60 dB → 0. Fully scheduled, so no clicks. */
  private env(g: AudioParam, t: number, attack: number, peak: number, dur: number) {
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(Math.max(1e-5, peak * 0.001), t + attack + dur);
    g.linearRampToValueAtTime(0, t + attack + dur + 0.03);
    return t + attack + dur + 0.04;
  }

  /** modulation index envelope, in Hz of deviation */
  private fm(
    car: OscillatorNode,
    t: number,
    hz: number,
    from: number,
    to: number,
    time: number,
    end: number,
  ) {
    const m = this.ctx.createOscillator();
    m.frequency.value = hz;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(from * hz, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.01, to * hz), t + time);
    m.connect(g).connect(car.frequency);
    m.start(t);
    m.stop(end);
  }

  private knock(t: number, dest: AudioNode, gain: number, freq: number, q: number, dur: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.001);
    g.gain.exponentialRampToValueAtTime(gain * 0.001, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.005);
    src.connect(bp).connect(g).connect(dest);
    // start somewhere different each time so knocks aren't identical
    const offset = (Math.floor(t * 1000) % 180) / 1000;
    src.start(t, offset, dur + 0.02);
  }

  /**
   * Play one landing.
   * @param voice LO | MID | HI
   * @param midi  note number
   * @param when  context time it should be heard (0 or the past = now)
   * @param vel   0..1, how hard the ball came down
   * @param pan   -1..1, where on the tray it landed
   */
  note(voice: number, midi: number, when: number, vel: number, pan: number) {
    this.voice(voice, midi, Math.max(when - AHEAD, this.ctx.currentTime + 0.002), vel, pan, 1, this.strips[voice], true);
  }

  /**
   * The note under a finger: the same voice, about 8 dB down, duller and
   * half as long, with no echo. It answers the touch at once; the ball that
   * arrives a moment later is the one that plays the note.
   * @param level 1 for a tap on a pad; more for a note nothing will follow
   */
  touch(voice: number, midi: number, when: number, pan: number, level = 1) {
    const t = Math.max(when, this.ctx.currentTime + 0.002);
    this.voice(voice, midi, t, Math.min(1, TOUCH.vel * level), pan, TOUCH.ring, this.hands[voice], false);
  }

  /**
   * One FM note.
   *
   * `tone` moves three things in every voice: how far the modulation index
   * starts above where it settles (the attack), where it settles (how many
   * overtones the held note keeps), and how long the note rings.
   */
  private voice(
    voice: number,
    midi: number,
    t: number,
    vel: number,
    pan: number,
    ringScale: number,
    dest: AudioNode,
    counted: boolean,
  ) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const tone = this.tone;
    // a soft landing is duller as well as quieter
    const hit = 0.55 + 0.45 * vel;
    const ring = (0.6 + 0.9 * tone) * ringScale;
    const amp = Math.pow(vel, 1.4);

    const out = ctx.createGain(); // envelope
    const kill = ctx.createGain(); // for stealing
    const panner = ctx.createStereoPanner();
    out.connect(kill).connect(panner).connect(dest);

    let end: number;

    if (voice === LO) {
      // round rubber thump. The fundamental (131–247 Hz) is below what a
      // phone speaker plays, so the held note keeps a second and third
      // harmonic: that is what carries the pitch on a small speaker.
      panner.pan.value = pan * 0.15;
      const dur = (0.5 + 0.4 * ring) * Math.pow(131 / f, 0.2);
      end = this.env(out.gain, t, 0.004, 0.31 * amp, dur);

      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 480 + 2300 * tone;
      lp.Q.value = 0.5;
      lp.connect(out);

      const car = ctx.createOscillator();
      car.frequency.setValueAtTime(f * 1.5, t);
      car.frequency.exponentialRampToValueAtTime(f, t + 0.03);
      const settle = 0.4 + 1.0 * tone;
      this.fm(car, t, f, settle + (0.5 + 1.6 * tone) * hit, settle, 0.18, end);
      car.connect(lp);
      car.start(t);
      car.stop(end);

      // a quiet octave below, for speakers that can use it
      const sub = ctx.createOscillator();
      sub.frequency.setValueAtTime(f * 0.75, t);
      sub.frequency.exponentialRampToValueAtTime(f * 0.5, t + 0.03);
      const subG = ctx.createGain();
      subG.gain.value = 0.22;
      sub.connect(subG).connect(out);
      sub.start(t);
      sub.stop(end);

      this.knock(t, kill, 0.05 * amp, 900, 0.8, 0.02);

      // the bass is monophonic: a new landing damps the last one
      if (counted) for (const l of this.live[LO]) l.kill.gain.setTargetAtTime(0, t, 0.03);
    } else if (voice === MID) {
      // tine / thumb-piano: warm body, a short metallic bite on the attack
      panner.pan.value = pan * 0.5;
      const dur = (0.9 + 1.0 * ring) * Math.pow(330 / f, 0.35);
      end = this.env(out.gain, t, 0.003, 0.27 * amp, dur);

      // high notes get less bite, or they turn to ice
      const ks = Math.min(1, Math.pow(440 / f, 0.5));
      const car = ctx.createOscillator();
      car.frequency.value = f;
      const settle = (0.1 + 0.55 * tone) * ks;
      this.fm(car, t, f, settle + (0.2 + 1.5 * tone) * hit * ks, settle, 0.22 + 0.16 * tone, end);
      this.fm(car, t, f * 4, (0.25 + 1.5 * tone) * hit * ks, 0.01, 0.05 + 0.06 * tone, end);
      car.connect(out);
      car.start(t);
      car.stop(end);

      // a quiet octave shimmer that dies quickly
      const oct = ctx.createOscillator();
      oct.frequency.value = f * 2.003;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.16 * (0.4 + tone), t);
      og.gain.exponentialRampToValueAtTime(0.002, t + dur * 0.4);
      oct.connect(og).connect(out);
      oct.start(t);
      oct.stop(end);

      this.knock(t, kill, 0.045 * amp, 2400, 1.2, 0.014);
    } else {
      // glass: a small inharmonic ping
      panner.pan.value = pan * 0.7;
      const dur = (0.35 + 0.6 * ring) * Math.pow(880 / f, 0.4);
      end = this.env(out.gain, t, 0.002, 0.21 * amp, dur);

      const ks = Math.min(1, Math.pow(900 / f, 0.6));
      const car = ctx.createOscillator();
      car.frequency.value = f;
      const settle = (0.03 + 0.3 * tone) * ks;
      this.fm(car, t, f * 3.01, settle + (0.25 + 1.3 * tone) * hit * ks, settle, 0.1 + 0.14 * tone, end);
      this.fm(car, t, f * 7.07, (0.1 + 0.6 * tone) * hit * ks, 0.005, 0.03, end);
      car.connect(out);
      car.start(t);
      car.stop(end);

      this.knock(t, kill, 0.03 * amp, 5200, 2, 0.008);
    }

    if (!counted) return;
    // bookkeeping + stealing
    const list = this.live[voice];
    const now = ctx.currentTime;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].end < now) list.splice(i, 1);
    list.push({ kill, start: t, end });
    while (list.length > STRIPS[voice].max) {
      const old = list.shift()!;
      old.kill.gain.setTargetAtTime(0, t, 0.015);
    }
  }

  /**
   * Take back a note that was scheduled for `when` and has not started yet:
   * the ball it belonged to was caught before it could land.
   */
  hush(voice: number, when: number) {
    const now = this.ctx.currentTime;
    const list = this.live[voice];
    for (let i = list.length - 1; i >= 0; i--) {
      const l = list[i];
      if (l.start <= now || l.start < when - AHEAD - 0.005) continue;
      list.splice(i, 1);
      l.kill.gain.cancelScheduledValues(0);
      l.kill.gain.value = 0;
      // anything it was going to damp or steal from rings on instead
      for (const o of list) if (o.start < l.start) o.kill.gain.cancelScheduledValues(l.start - 0.001);
    }
  }

  /** a ball stopping in a hand: a soft, dry pat, lower for the bigger ball */
  pat(voice: number, power: number, when = 0) {
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime + 0.002);
    const f = [150, 215, 300][voice];
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12 * power, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0002, t + 0.07);
    g.gain.linearRampToValueAtTime(0, t + 0.08);
    o.connect(g).connect(this.hands[LO]);
    o.start(t);
    o.stop(t + 0.09);
    this.knock(t, this.hands[LO], 0.07 * power, f * 6, 0.9, 0.018);
  }

  /** ball against the tray wall: a dry little tock */
  tick(when: number, power: number, pan: number) {
    const ctx = this.ctx;
    const t = Math.max(when - AHEAD, ctx.currentTime + 0.002);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan * 0.8;
    panner.connect(this.strips[HI]);
    this.knock(t, panner, 0.09 * power, 1700, 3, 0.012);

    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(300, t + 0.03);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05 * power, t + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.00005, t + 0.045);
    g.gain.linearRampToValueAtTime(0, t + 0.05);
    o.connect(g).connect(panner);
    o.start(t);
    o.stop(t + 0.06);
  }

  /** ball dropping back into its nest */
  thud(when: number, power: number) {
    const ctx = this.ctx;
    const t = Math.max(when - AHEAD, ctx.currentTime + 0.002);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(85, t + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22 * power, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0002, t + 0.13);
    g.gain.linearRampToValueAtTime(0, t + 0.14);
    o.connect(g).connect(this.strips[LO]);
    o.start(t);
    o.stop(t + 0.15);
    this.knock(t, this.strips[LO], 0.05 * power, 600, 0.7, 0.025);
  }
}
