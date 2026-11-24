/**
 * Meters for a rendered buffer. Nobody can listen to an offline render, so
 * these are what the sound is judged by. No DOM, no Web Audio: plain arrays
 * in, numbers out, so they run in a browser or under `node --test`.
 */

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const dbPower = (x: number) => (x > 0 ? 10 * Math.log10(x) : -Infinity);

export function peak(ch: Float32Array[]): number {
  let m = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]));
  return db(m);
}

export function rms(ch: Float32Array[]): number {
  let s = 0;
  let n = 0;
  for (const c of ch) {
    for (let i = 0; i < c.length; i++) s += c[i] * c[i];
    n += c.length;
  }
  return dbPower(s / Math.max(1, n));
}

/** direct-form biquad, in place on a copy */
function biquad(x: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/**
 * Integrated loudness, ITU-R BS.1770-4: K-weighting, 400 ms blocks with 75%
 * overlap, an absolute gate at -70 LUFS and a relative one 10 LU under the
 * rest. The filter coefficients are the standard's, which are for 48 kHz.
 */
export function lufs(ch: Float32Array[], sr: number): number {
  if (sr !== 48000) throw new Error("lufs() is only calibrated for 48 kHz");
  const k = ch.map((c) =>
    biquad(
      biquad(c, 1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585),
      1,
      -2,
      1,
      -1.99004745483398,
      0.99007225036621,
    ),
  );
  const block = Math.round(0.4 * sr);
  const hop = Math.round(0.1 * sr);
  const powers: number[] = [];
  for (let at = 0; at + block <= k[0].length; at += hop) {
    let p = 0;
    for (const c of k) {
      let s = 0;
      for (let i = at; i < at + block; i++) s += c[i] * c[i];
      p += s / block;
    }
    powers.push(p);
  }
  const loud = (p: number) => -0.691 + dbPower(p);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const abs = powers.filter((p) => loud(p) > -70);
  if (!abs.length) return -Infinity;
  const gate = loud(mean(abs)) - 10;
  const rel = abs.filter((p) => loud(p) > gate);
  return loud(mean(rel));
}

/** in-place radix-2 FFT */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** long-term average power spectrum (Welch, Hann, 50% overlap), channels averaged */
export function spectrum(ch: Float32Array[], size = 8192): Float64Array {
  const out = new Float64Array(size / 2);
  const win = new Float64Array(size);
  let norm = 0;
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    norm += win[i] * win[i];
  }
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let frames = 0;
  for (const c of ch) {
    for (let at = 0; at + size <= c.length; at += size / 2) {
      for (let i = 0; i < size; i++) {
        re[i] = c[at + i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let i = 0; i < size / 2; i++) out[i] += (2 * (re[i] * re[i] + im[i] * im[i])) / (norm * size);
      frames++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= Math.max(1, frames);
  return out;
}

export const BANDS = [
  ["sub", 0, 120],
  ["low", 120, 300],
  ["mid", 300, 2000],
  ["presence", 2000, 6000],
  ["air", 6000, 24000],
] as const;

export interface Stats {
  seconds: number;
  /** sample peak, dBFS */
  peak: number;
  rms: number;
  lufs: number;
  /** peak minus rms: how spiky it is */
  crest: number;
  /** samples at or beyond full scale */
  clipped: number;
  /** each band's share of the power, dB relative to the whole */
  bands: Record<string, number>;
  /** what is left for a phone speaker: power above 300 Hz, dB relative to the whole */
  phone: number;
  /** spectral centroid, Hz */
  centroid: number;
  /** L/R correlation: 1 mono, 0 unrelated, below 0 cancels in mono */
  corr: number;
}

export function measure(ch: Float32Array[], sr: number): Stats {
  const spec = spectrum(ch);
  const hz = sr / 2 / spec.length;
  let total = 0;
  let weighted = 0;
  for (let i = 1; i < spec.length; i++) {
    total += spec[i];
    weighted += spec[i] * i * hz;
  }
  const share = (lo: number, hi: number) => {
    let s = 0;
    for (let i = Math.max(1, Math.ceil(lo / hz)); i < Math.min(spec.length, Math.ceil(hi / hz)); i++) s += spec[i];
    return dbPower(s / (total || 1));
  };
  const bands: Record<string, number> = {};
  for (const [name, lo, hi] of BANDS) bands[name] = round(share(lo, hi));

  let clipped = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) >= 0.999) clipped++;

  let lr = 0;
  let ll = 0;
  let rr = 0;
  if (ch.length > 1) {
    for (let i = 0; i < ch[0].length; i++) {
      lr += ch[0][i] * ch[1][i];
      ll += ch[0][i] * ch[0][i];
      rr += ch[1][i] * ch[1][i];
    }
  }
  const p = peak(ch);
  const r = rms(ch);
  return {
    seconds: round(ch[0].length / sr),
    peak: round(p),
    rms: round(r),
    lufs: round(lufs(ch, sr)),
    crest: round(p - r),
    clipped,
    bands,
    phone: round(share(300, sr / 2)),
    centroid: Math.round(weighted / (total || 1)),
    corr: ch.length > 1 ? round(lr / Math.sqrt(ll * rr || 1), 3) : 1,
  };
}

function round(x: number, places = 2) {
  const k = Math.pow(10, places);
  return Math.round(x * k) / k;
}

/**
 * Onsets: where the level jumps. Returns the time and height (dBFS, 5 ms
 * peak-hold envelope) of each rise of more than `rise` dB within 12 ms.
 * Used to count how many attacks a gesture makes, and how loud each is.
 */
export function onsets(ch: Float32Array[], sr: number, rise = 6, floor = -50): { t: number; level: number }[] {
  const win = Math.round(0.005 * sr);
  const env: number[] = [];
  for (let at = 0; at + win <= ch[0].length; at += win) {
    let m = 0;
    for (const c of ch) for (let i = at; i < at + win; i++) m = Math.max(m, Math.abs(c[i]));
    env.push(db(m));
  }
  const out: { t: number; level: number }[] = [];
  for (let i = 3; i < env.length - 3; i++) {
    const before = Math.max(env[i - 1], env[i - 2], env[i - 3]);
    const after = Math.max(env[i], env[i + 1], env[i + 2]);
    if (after < floor || after - before < rise) continue;
    const last = out[out.length - 1];
    if (last && i * 0.005 - last.t < 0.03) {
      last.level = Math.max(last.level, round(after));
      continue;
    }
    out.push({ t: round(i * 0.005, 3), level: round(after) });
  }
  return out;
}
