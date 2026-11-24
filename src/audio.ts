/**
 * Sound. Three small FM voices (one per ball), a tempo-synced ping-pong
 * echo, a generated room, and a soft limiter. No samples.
 *
 * Everything is built against BaseAudioContext so the same graph renders in
 * an OfflineAudioContext for level / click checks.
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
  end: number;
}

/** gain after the compressor; set by measuring offline renders */
const MAKEUP = 1.5;

const STRIPS = [
  // dry, echo send, room send, max voices
  { dry: 0.95, echo: 0.0, room: 0.05, max: 3 },
  { dry: 0.8, echo: 0.2, room: 0.2, max: 10 },
  { dry: 0.6, echo: 0.3, room: 0.26, max: 8 },
];

export class Sound {
  readonly ctx: BaseAudioContext;
  /** 0 = soft and short, 1 = bright and ringing */
  tone = 0.5;

  private strips: GainNode[] = [];
  private live: Live[][] = [[], [], []];
  private noise: AudioBuffer;
  private delayL: DelayNode;
  private delayR: DelayNode;

  constructor(ctx: BaseAudioContext, stepSeconds: number) {
    this.ctx = ctx;

    // ── master: sum → compressor → soft clip → out ──
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

    // ── echo: ping-pong, darkening on each repeat ──
    const echoIn = ctx.createGain();
    this.delayL = ctx.createDelay(2);
    this.delayR = ctx.createDelay(2);
    this.delayL.delayTime.value = this.delayR.delayTime.value = stepSeconds * 3;
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
    echoIn.connect(this.delayL);
    this.delayL.connect(dampL).connect(fbL).connect(this.delayR);
    this.delayR.connect(dampR).connect(fbR).connect(this.delayL);
    this.delayL.connect(panL).connect(sum);
    this.delayR.connect(panR).connect(sum);

    // ── room: convolver with a generated tail ──
    const room = ctx.createConvolver();
    room.buffer = this.makeRoom(2.4, 0.34);
    const roomOut = ctx.createGain();
    roomOut.gain.value = 0.9;
    room.connect(roomOut).connect(sum);
    // a little of the echo goes to the room so repeats sit back
    const echoToRoom = ctx.createGain();
    echoToRoom.gain.value = 0.25;
    this.delayL.connect(echoToRoom);
    this.delayR.connect(echoToRoom);
    echoToRoom.connect(room);

    // ── one channel strip per ball ──
    for (const s of STRIPS) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      dry.gain.value = s.dry;
      input.connect(dry).connect(sum);
      if (s.echo > 0) {
        const e = ctx.createGain();
        e.gain.value = s.echo;
        input.connect(e).connect(echoIn);
      }
      const r = ctx.createGain();
      r.gain.value = s.room;
      input.connect(r).connect(room);
      this.strips.push(input);
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

  setStep(stepSeconds: number) {
    const t = this.ctx.currentTime;
    const v = Math.min(1.9, stepSeconds * 3);
    this.delayL.delayTime.setTargetAtTime(v, t, 0.12);
    this.delayR.delayTime.setTargetAtTime(v, t, 0.12);
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
   * @param when  context time (0 or the past = now)
   * @param vel   0..1, how hard the ball came down
   * @param pan   -1..1, where on the tray it landed
   */
  note(voice: number, midi: number, when: number, vel: number, pan: number) {
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime + 0.002);
    const f = mtof(midi);
    const bright = (0.35 + 1.3 * this.tone) * (0.55 + 0.45 * vel);
    const ring = 0.6 + 0.9 * this.tone;
    const amp = Math.pow(vel, 1.4);

    const out = ctx.createGain(); // envelope
    const kill = ctx.createGain(); // for stealing
    const panner = ctx.createStereoPanner();
    out.connect(kill).connect(panner).connect(this.strips[voice]);

    let end: number;

    if (voice === LO) {
      // round rubber thump with a sub underneath
      panner.pan.value = pan * 0.15;
      const dur = (0.75 + 0.45 * ring) * Math.pow(131 / f, 0.2);
      end = this.env(out.gain, t, 0.004, 0.32 * amp, dur);

      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 500 + 1500 * this.tone;
      lp.Q.value = 0.5;
      lp.connect(out);

      const car = ctx.createOscillator();
      car.frequency.setValueAtTime(f * 1.5, t);
      car.frequency.exponentialRampToValueAtTime(f, t + 0.03);
      this.fm(car, t, f, 1.5 * bright, 0.18, 0.14, end);
      car.connect(lp);
      car.start(t);
      car.stop(end);

      const sub = ctx.createOscillator();
      sub.frequency.setValueAtTime(f * 0.75, t);
      sub.frequency.exponentialRampToValueAtTime(f * 0.5, t + 0.03);
      const subG = ctx.createGain();
      subG.gain.value = 0.6;
      sub.connect(subG).connect(out);
      sub.start(t);
      sub.stop(end);

      this.knock(t, kill, 0.05 * amp, 900, 0.8, 0.02);

      // the bass is monophonic: a new landing damps the last one
      for (const l of this.live[LO]) l.kill.gain.setTargetAtTime(0, t, 0.03);
    } else if (voice === MID) {
      // tine / thumb-piano: warm body, a short metallic bite on the attack
      panner.pan.value = pan * 0.5;
      const dur = (0.9 + 1.0 * ring) * Math.pow(330 / f, 0.35);
      end = this.env(out.gain, t, 0.003, 0.27 * amp, dur);

      // high notes get less bite, or they turn to ice
      const ks = Math.min(1, Math.pow(440 / f, 0.5));
      const car = ctx.createOscillator();
      car.frequency.value = f;
      this.fm(car, t, f, 0.85 * bright * ks, 0.12, 0.3, end);
      this.fm(car, t, f * 4, 0.9 * bright * ks, 0.01, 0.07, end);
      car.connect(out);
      car.start(t);
      car.stop(end);

      // a quiet octave shimmer that dies quickly
      const oct = ctx.createOscillator();
      oct.frequency.value = f * 2.003;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.16 * (0.4 + this.tone), t);
      og.gain.exponentialRampToValueAtTime(0.002, t + dur * 0.4);
      oct.connect(og).connect(out);
      oct.start(t);
      oct.stop(end);

      this.knock(t, kill, 0.045 * amp, 2400, 1.2, 0.014);
    } else {
      // glass: a small inharmonic ping
      panner.pan.value = pan * 0.7;
      const dur = (0.35 + 0.6 * ring) * Math.pow(880 / f, 0.4);
      end = this.env(out.gain, t, 0.002, 0.17 * amp, dur);

      const ks = Math.min(1, Math.pow(900 / f, 0.6));
      const car = ctx.createOscillator();
      car.frequency.value = f;
      this.fm(car, t, f * 3.01, 0.75 * bright * ks, 0.03, 0.12, end);
      this.fm(car, t, f * 7.07, 0.35 * bright * ks, 0.005, 0.03, end);
      car.connect(out);
      car.start(t);
      car.stop(end);

      this.knock(t, kill, 0.03 * amp, 5200, 2, 0.008);
    }

    // bookkeeping + stealing
    const list = this.live[voice];
    const now = ctx.currentTime;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].end < now) list.splice(i, 1);
    list.push({ kill, end });
    while (list.length > STRIPS[voice].max) {
      const old = list.shift()!;
      old.kill.gain.setTargetAtTime(0, t, 0.015);
    }
  }

  /** ball against the tray wall: a dry little tock */
  tick(when: number, power: number, pan: number) {
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime + 0.002);
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
    const t = Math.max(when, ctx.currentTime + 0.002);
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
