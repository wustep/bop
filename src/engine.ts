/**
 * The bounce engine. No DOM, no audio — just balls, hops and time.
 *
 * ── model ────────────────────────────────────────────────────────────────
 *  The tray is a W×H lattice of wells. A ball crosses it at a constant
 *  speed of one well per step (a step is a 16th note), bouncing as it goes:
 *
 *    stride (2, 1)  →  each hop spans 2 wells  →  a landing every 2 steps
 *
 *  so melody *and* rhythm both fall out of the direction it was sent in.
 *  Walls reflect it, which folds the straight line into a loop.
 *
 *  BOUNCE is the restitution. At 1 the ball never loses energy and the loop
 *  is perpetual and grid-locked. Below 1 every hop is `bounce` times the
 *  last — shorter and sooner — the classic accelerating rattle of a dropped
 *  ball, until it settles in whichever well it ends up in.
 *
 *  Time is kept in steps so tempo can change under a ball in flight.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface Vec {
  x: number;
  y: number;
}

export const W = 4;
export const H = 4;

/** schedule sounds this far ahead of the clock (seconds) */
const LOOKAHEAD = 0.12;
/** a hop shorter than this (seconds) is the ball coming to rest */
const SETTLE = 0.05;
/** release slower than this (cells/s) is a drop, faster is a throw */
const FLICK = 3;
/** throw speed (cells/s) that buys one more cell of stride */
const FLICK_PER_CELL = 7;
/** steps between landings for a ball bouncing on the spot: a dribble in eighths */
const DRIBBLE = 2;

export interface WallHit {
  t: number;
  nx: number;
  ny: number;
  sent: boolean;
}

export interface Hop {
  /** straight flight (entering, going home, redirected mid-air) vs. folded in-tray hop */
  free: boolean;
  a: Vec;
  b: Vec;
  /** in-tray hops: ideal unfolded start + displacement */
  u: Vec;
  s: Vec;
  /** height at t0 (non-zero when a flight was interrupted) and extra apex height */
  z0: number;
  h: number;
  t0: number;
  t1: number;
  /** pad it lands on, or -1 for the nest */
  pad: number;
  vel: number;
  sent: boolean;
  walls: WallHit[];
}

export type FxKind = "land" | "wall" | "home" | "settle";

export interface Fx {
  t: number;
  kind: FxKind;
  pad: number;
  nx: number;
  ny: number;
  power: number;
}

export type Mode = "home" | "rest" | "fly" | "held";

/**
 * A course a ball has been set on, in a form that can be written down and
 * set again later: it lands on `pad`, carries on by `sx, sy`, and `phase`
 * says when, in steps, against the other balls.
 */
export interface Throw {
  pad: number;
  sx: number;
  sy: number;
  phase: number;
}

export interface Ball {
  id: number;
  mode: Mode;
  /** where it rests / last landed, in cell coords (the nest is off-lattice) */
  cell: Vec;
  home: Vec;
  /** ideal (un-snapped) landing point and the stride that carries on from it */
  ideal: Vec;
  stride: Vec;
  dur: number;
  hop: Hop | null;
  prev: Hop | null;
  /** pad to head for at the next landing, or -1 */
  target: number;
  homing: boolean;
  /** delayed launch (used by the play key) */
  serveAt: number;
  servePad: number;
  /** how far past an edge well the centre can travel before touching the wall (cells) */
  edge: number;
  fx: Fx[];
  /** the player has just set a new course; it is written down at the next landing */
  fresh: boolean;
  /** the course it is on: where it first landed, the stride it left with, and at which step */
  course: { pad: number; stride: Vec; t: number } | null;
  /** stride to leave a served landing with, if the serve asked for one */
  serveStride: Vec | null;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
}

export interface Hooks {
  /** `when` is in clock seconds and may be slightly in the future */
  land(ball: Ball, pad: number, when: number, vel: number): void;
  wall(ball: Ball, when: number, power: number, x: number): void;
  home(ball: Ball, when: number): void;
  /** a landing already announced for `when` is not going to happen after all */
  hush?(ball: Ball, when: number): void;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;
const cheb = (v: Vec) => Math.max(Math.abs(v.x), Math.abs(v.y));
/** how many steps a hop of this stride takes */
const stepsOf = (s: Vec) => cheb(s) || DRIBBLE;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * Steps until a lossless ball on this stride is back in the same well going
 * the same way. Walls fold a line of travel every 2n wells, so it is short:
 * 24 steps at most for a stride of three, 40 for the five-well stride a ball
 * can leave a far nest with.
 */
export function period(sx: number, sy: number): number {
  const ax = Math.abs(Math.round(sx));
  const ay = Math.abs(Math.round(sy));
  const hx = ax ? (2 * W) / gcd(2 * W, ax) : 1;
  const hy = ay ? (2 * H) / gcd(2 * H, ay) : 1;
  const hops = (hx * hy) / gcd(hx, hy);
  return hops * (Math.max(ax, ay) || DRIBBLE);
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** reflect an unbounded coordinate into the tray, walls half a cell past the edge wells */
function fold(x: number, n: number): number {
  const m = mod(x + 0.5, 2 * n);
  return m < n ? m - 0.5 : 2 * n - m - 0.5;
}
function mirrored(x: number, n: number): boolean {
  return mod(x + 0.5, 2 * n) >= n;
}
/** stretch the half cell beyond an edge well so the ball's rim, not its centre, meets the wall */
function reach(f: number, n: number, edge: number): number {
  if (f < 0) return f * 2 * edge;
  if (f > n - 1) return n - 1 + (f - (n - 1)) * 2 * edge;
  return f;
}

export const padCell = (pad: number): Vec => ({ x: pad % W, y: Math.floor(pad / W) });
export const cellPad = (c: Vec): number => c.y * W + c.x;

export class Engine {
  readonly balls: Ball[] = [];
  /** restitution, 0..1. 1 = perpetual. */
  bounce = 1;
  /** seconds the picture runs behind the engine so it matches what is heard */
  lag = 0;

  private step0 = 0;
  private time0 = 0;
  private S = 15 / 96;
  private phase = 0;
  private hooks: Hooks;

  constructor(hooks: Hooks, count: number) {
    this.hooks = hooks;
    for (let id = 0; id < count; id++) {
      this.balls.push({
        id,
        mode: "home",
        cell: { x: id, y: -1 },
        home: { x: id, y: -1 },
        ideal: { x: id, y: -1 },
        stride: { x: 0, y: 1 },
        dur: 1,
        hop: null,
        prev: null,
        target: -1,
        homing: false,
        serveAt: -1,
        servePad: -1,
        edge: 0.4,
        fx: [],
        fresh: false,
        course: null,
        serveStride: null,
      });
    }
  }

  // ── transport ──────────────────────────────────────────────────────────

  get stepSeconds() {
    return this.S;
  }
  stepAt(t: number) {
    return this.step0 + (t - this.time0) / this.S;
  }
  timeOf(step: number) {
    return this.time0 + (step - this.step0) * this.S;
  }
  setTempo(bpm: number, now: number) {
    this.step0 = this.stepAt(now);
    this.time0 = now;
    this.S = 15 / bpm;
  }

  get anyOut() {
    return this.balls.some((b) => b.mode !== "home" || b.serveAt >= 0);
  }

  setHome(id: number, cell: Vec) {
    const b = this.balls[id];
    b.home = cell;
    if (b.mode === "home") b.cell = { ...cell };
  }

  // ── gestures ───────────────────────────────────────────────────────────

  /** send a ball to a pad: now if it is sitting still, at its next landing if it is in the air */
  tap(id: number, pad: number, now: number) {
    const b = this.balls[id];
    const s = this.stepAt(now);
    if (b.mode === "held") return;
    b.serveAt = -1;
    b.homing = false;
    b.fresh = true;
    if (b.mode === "home") {
      this.enter(b, pad, s, b.home, 0);
    } else if (b.mode === "rest") {
      b.mode = "fly";
      this.throwTo(b, pad, s);
    } else if (b.hop && b.hop.pad < 0) {
      // caught on its way home: turn it around from where it is
      const sv = this.stepAt(now - this.lag);
      const p = this.pose(b, sv, { x: 0, y: 0, z: 0 });
      this.cut(b, sv);
      this.enter(b, pad, sv, { x: p.x, y: p.y }, p.z);
    } else {
      b.target = pad;
    }
  }

  /** call a ball back to its nest, from wherever it is */
  recall(id: number, now: number) {
    const b = this.balls[id];
    b.serveAt = -1;
    b.target = -1;
    b.fresh = false;
    b.course = null;
    if (b.mode === "home" || b.mode === "held") return;
    if (b.mode === "rest") {
      b.mode = "fly";
      this.flyHome(b, this.stepAt(now), b.cell, 0);
      return;
    }
    if (b.hop && b.hop.pad < 0) return;
    const sv = this.stepAt(now - this.lag);
    const p = this.pose(b, sv, { x: 0, y: 0, z: 0 });
    this.cut(b, sv);
    this.flyHome(b, sv, { x: p.x, y: p.y }, p.z);
  }

  /**
   * A hand takes the ball: it leaves the simulation and goes where it is
   * carried. Works on a ball in any state, so one in flight can be caught.
   */
  hold(id: number, at: Vec) {
    const b = this.balls[id];
    b.serveAt = -1;
    b.target = -1;
    b.homing = false;
    b.fx.length = 0;
    b.fresh = false;
    b.course = null;
    this.unsay(b);
    b.hop = null;
    b.prev = null;
    b.mode = "held";
    b.cell = { ...at };
  }

  carry(id: number, at: Vec) {
    const b = this.balls[id];
    if (b.mode === "held") b.cell = { ...at };
  }

  /**
   * Let go. A still hand drops the ball into the nearest well (or sends it
   * home if it is off the tray); a moving hand throws it — direction from
   * the hand, stride from how hard.
   * @param vel cells per second, y up
   * @param z0  how high it was being held
   */
  release(id: number, now: number, vel: Vec, z0: number) {
    const b = this.balls[id];
    if (b.mode !== "held") return;
    const t0 = this.stepAt(now);
    const at = b.cell;
    const speed = Math.hypot(vel.x, vel.y);
    const overTray = at.x > -0.8 && at.x < W - 0.2 && at.y > -0.8 && at.y < H - 0.2;
    b.mode = "fly";
    b.fresh = true;
    if (!overTray && speed < FLICK) {
      this.flyHome(b, t0, at, z0);
      return;
    }
    const from = {
      x: clamp(Math.round(at.x), 0, W - 1),
      y: clamp(Math.round(at.y), 0, H - 1),
    };
    const s = { x: 0, y: 0 };
    if (speed >= FLICK) {
      const n = clamp(Math.round(speed / FLICK_PER_CELL), 1, 3);
      s.x = Math.round((vel.x / speed) * n);
      s.y = Math.round((vel.y / speed) * n);
    }
    const d = stepsOf(s);
    const within = at.x >= -0.5 && at.x <= W - 0.5 && at.y >= -0.5 && at.y <= H - 0.5;
    if (within) {
      b.stride = s;
      b.dur = d;
      this.gridHop(b, from, s, t0, this.quantize(b, t0 + d), d, z0);
      return;
    }
    // let go beyond the walls: it sails in over them, then carries on as thrown
    const ex = from.x + s.x;
    const ey = from.y + s.y;
    const land = {
      x: clamp(Math.round(fold(ex, W)), 0, W - 1),
      y: clamp(Math.round(fold(ey, H)), 0, H - 1),
    };
    this.enter(b, cellPad(land), t0, at, z0, {
      x: mirrored(ex, W) ? -s.x : s.x,
      y: mirrored(ey, H) ? -s.y : s.y,
    });
  }

  /**
   * Launch from the nest after a delay, in steps. With a stride, the ball
   * lands on the pad and leaves it that way, whatever line it flew in on.
   */
  serve(id: number, pad: number, now: number, delaySteps: number, stride?: Vec) {
    const b = this.balls[id];
    if (b.mode !== "home") return;
    b.serveAt = this.stepAt(now) + delaySteps;
    b.servePad = pad;
    b.serveStride = stride ? { ...stride } : null;
  }

  /**
   * What the balls are doing, written down so it can be done again. A ball
   * in its nest, in a hand or on its way home is null.
   *
   * A lossless ball repeats, so its `phase` is taken modulo its period: the
   * same loop always reads the same however long it has been running.
   */
  snapshot(): (Throw | null)[] {
    const out = this.balls.map((b): Throw | null => {
      const c = b.course;
      if (!c || b.mode === "home" || b.mode === "held" || (b.hop !== null && b.hop.pad < 0)) return null;
      const sx = Math.round(c.stride.x);
      const sy = Math.round(c.stride.y);
      return { pad: c.pad, sx, sy, phase: mod(Math.round(c.t - this.phase), period(sx, sy)) };
    });
    // Only the phases against each other matter, so slide them all together
    // to where the latest is as early as it can be. One loop, one spelling:
    // every slide there is has to be tried, and together the balls only
    // repeat after the least common multiple of their periods.
    const live = out.filter((t): t is Throw => t !== null);
    const all = live.reduce((n, t) => {
      const p = period(t.sx, t.sy);
      return (n * p) / gcd(n, p);
    }, 1);
    let best = 0;
    let bestMax = Infinity;
    for (let k = 0; k < all; k++) {
      const max = Math.max(0, ...live.map((t) => mod(t.phase - k, period(t.sx, t.sy))));
      if (max < bestMax) {
        bestMax = max;
        best = k;
      }
    }
    for (const t of live) t.phase = mod(t.phase - best, period(t.sx, t.sy));
    return out;
  }

  /**
   * Set the balls on courses that were written down with snapshot(). They
   * leave their nests so as to land where and when the snapshot says, a few
   * steps from now.
   */
  restore(throws: (Throw | null)[], now: number) {
    // as long as the longest first hop, so nobody has to have left already
    const lead = Math.max(1, ...throws.map((th) => (th ? stepsOf({ x: th.sx, y: th.sy }) : 0)));
    throws.forEach((th, id) => {
      if (!th || id >= this.balls.length) return;
      const stride = { x: th.sx, y: th.sy };
      this.serve(id, th.pad, now, lead + th.phase - stepsOf(stride), stride);
    });
  }

  // ── simulation ─────────────────────────────────────────────────────────

  advance(now: number) {
    const s = this.stepAt(now);
    const horizon = now + LOOKAHEAD;
    for (const b of this.balls) {
      if (b.serveAt >= 0 && s >= b.serveAt) {
        const at = b.serveAt;
        b.serveAt = -1;
        if (b.mode === "home") {
          b.fresh = true;
          this.enter(b, b.servePad, at, b.home, 0, b.serveStride ?? undefined);
        }
      }
      let guard = 0;
      while (b.hop && guard++ < 48) {
        const hop = b.hop;
        this.emit(b, hop, horizon);
        if (s < hop.t1) break;
        this.land(b, hop);
      }
    }
  }

  private emit(b: Ball, hop: Hop, horizon: number) {
    for (const w of hop.walls) {
      if (w.sent) continue;
      const when = this.timeOf(w.t);
      if (when > horizon) break;
      w.sent = true;
      const k = (w.t - hop.t0) / (hop.t1 - hop.t0);
      this.hooks.wall(b, when, 0.5 + 0.5 * hop.vel, hop.u.x + hop.s.x * k);
    }
    if (hop.sent) return;
    const when = this.timeOf(hop.t1);
    if (when > horizon) return;
    hop.sent = true;
    if (hop.pad >= 0) this.hooks.land(b, hop.pad, when, hop.vel);
    else this.hooks.home(b, when);
  }

  private land(b: Ball, hop: Hop) {
    b.prev = hop;
    b.cell = { ...hop.b };
    const t = hop.t1;

    if (hop.pad < 0) {
      b.mode = "home";
      b.hop = null;
      b.homing = false;
      b.target = -1;
      return;
    }

    if (hop.free) {
      b.ideal = { ...hop.b };
    } else {
      const ex = hop.u.x + hop.s.x;
      const ey = hop.u.y + hop.s.y;
      b.ideal = { x: fold(ex, W), y: fold(ey, H) };
      b.stride = {
        x: mirrored(ex, W) ? -hop.s.x : hop.s.x,
        y: mirrored(ey, H) ? -hop.s.y : hop.s.y,
      };
    }

    if (b.fresh) {
      b.fresh = false;
      b.course = { pad: hop.pad, stride: { ...b.stride }, t };
    }

    if (b.homing) {
      this.flyHome(b, t, b.cell, 0);
    } else if (b.target >= 0) {
      b.fresh = true;
      this.throwTo(b, b.target, t);
    } else if (this.bounce >= 1) {
      // lossless: stay on the lattice and on the grid
      const s = { x: Math.round(b.stride.x), y: Math.round(b.stride.y) };
      const d = stepsOf(s);
      b.stride = s;
      b.dur = d;
      this.gridHop(b, b.cell, s, t, this.quantize(b, t + d), d);
    } else {
      const e = this.bounce;
      const s = { x: b.stride.x * e, y: b.stride.y * e };
      const d = b.dur * e;
      if (d * this.S < SETTLE) {
        b.mode = "rest";
        b.hop = null;
        // at rest it is simply here
        b.course = { pad: cellPad(b.cell), stride: { x: 0, y: 0 }, t };
        b.fx.push({ t, kind: "settle", pad: cellPad(b.cell), nx: 0, ny: 0, power: 0.3 });
        return;
      }
      b.stride = s;
      b.dur = d;
      this.gridHop(b, b.ideal, s, t, t + d, d);
    }
  }

  /** a fresh throw from the well the ball is in, landing exactly on `pad` */
  private throwTo(b: Ball, pad: number, t0: number) {
    const p = padCell(pad);
    const s = { x: p.x - b.cell.x, y: p.y - b.cell.y };
    const d = stepsOf(s);
    b.target = -1;
    b.stride = s;
    b.dur = d;
    this.gridHop(b, b.cell, s, t0, this.quantize(b, t0 + d), d);
  }

  /** a straight flight onto the tray from outside it (or from mid-air) */
  private enter(b: Ball, pad: number, t0: number, from: Vec, z0: number, stride?: Vec) {
    const p = padCell(pad);
    const s = stride ?? { x: Math.round(p.x - from.x), y: Math.round(p.y - from.y) };
    if (!stride && s.x === 0 && s.y === 0) s.y = 1;
    const d = stepsOf(s);
    const t1 = this.quantize(b, t0 + d);
    b.mode = "fly";
    b.target = -1;
    b.stride = s;
    b.dur = d;
    const vel = this.velocity(d);
    b.hop = {
      free: true,
      a: { ...from },
      b: p,
      u: { ...from },
      s: { x: p.x - from.x, y: p.y - from.y },
      z0,
      h: this.height((t1 - t0) * this.S),
      t0,
      t1,
      pad,
      vel,
      sent: false,
      walls: [],
    };
    b.fx.push({ t: t1, kind: "land", pad, nx: 0, ny: 0, power: vel });
  }

  private gridHop(b: Ball, u: Vec, s: Vec, t0: number, t1: number, d: number, z0 = 0) {
    const ex = u.x + s.x;
    const ey = u.y + s.y;
    const land = {
      x: clamp(Math.round(fold(ex, W)), 0, W - 1),
      y: clamp(Math.round(fold(ey, H)), 0, H - 1),
    };
    const vel = this.velocity(d);
    const walls: WallHit[] = [];
    const span = t1 - t0;
    const cross = (start: number, delta: number, n: number, horizontal: boolean) => {
      if (delta === 0) return;
      const from = start + 0.5;
      const to = from + delta;
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      for (let k = Math.ceil(lo / n); k * n < hi; k++) {
        const at = k * n;
        if (at <= lo) continue;
        const side = mod(k, 2) === 1 ? 1 : -1;
        walls.push({
          t: t0 + ((at - from) / delta) * span,
          nx: horizontal ? side : 0,
          ny: horizontal ? 0 : side,
          sent: false,
        });
      }
    };
    cross(u.x, s.x, W, true);
    cross(u.y, s.y, H, false);
    walls.sort((p, q) => p.t - q.t);

    b.hop = {
      free: false,
      a: { ...b.cell },
      b: land,
      u: { ...u },
      s: { ...s },
      z0,
      h: this.height(span * this.S),
      t0,
      t1,
      pad: cellPad(land),
      vel,
      sent: false,
      walls,
    };
    for (const w of walls)
      b.fx.push({ t: w.t, kind: "wall", pad: -1, nx: w.nx, ny: w.ny, power: vel });
    b.fx.push({ t: t1, kind: "land", pad: cellPad(land), nx: 0, ny: 0, power: vel });
  }

  private flyHome(b: Ball, t0: number, from: Vec, z0: number) {
    const dist = Math.hypot(b.home.x - from.x, b.home.y - from.y);
    const seconds = 0.24 + 0.05 * dist;
    const t1 = t0 + seconds / this.S;
    b.homing = false;
    b.target = -1;
    b.hop = {
      free: true,
      a: { ...from },
      b: { ...b.home },
      u: { ...from },
      s: { x: b.home.x - from.x, y: b.home.y - from.y },
      z0,
      h: 0.35 + 0.12 * dist,
      t0,
      t1,
      pad: -1,
      vel: 0.6,
      sent: false,
      walls: [],
    };
    b.fx.push({ t: t1, kind: "home", pad: -1, nx: 0, ny: 0, power: 0.6 });
  }

  /** abandon the current hop at step `s` (its future effects never happen) */
  private cut(b: Ball, s: number) {
    this.unsay(b);
    b.prev = b.hop;
    b.fx = b.fx.filter((f) => f.t <= s);
  }

  /** sounds are sent a little ahead of time; take back the one for a landing that is being abandoned */
  private unsay(b: Ball) {
    const hop = b.hop;
    if (hop && hop.sent) this.hooks.hush?.(b, this.timeOf(hop.t1));
  }

  /**
   * Keep lossless balls on one shared 16th grid so they stay in time with
   * each other. The first ball in the air defines where the grid sits.
   */
  private quantize(b: Ball, t: number): number {
    if (this.bounce < 1) return t;
    const others = this.balls.some(
      (o) => o !== b && o.mode === "fly" && o.hop !== null && o.hop.pad >= 0,
    );
    if (!others) {
      this.phase = t - Math.floor(t);
      return t;
    }
    return Math.ceil(t - 0.5 - this.phase - 1e-6) + this.phase;
  }

  /** a longer fall lands harder */
  private velocity(d: number): number {
    return clamp(0.2 + 0.7 * Math.pow(d, 0.7), 0.2, 1);
  }

  /** apex height in cells for a hop lasting `seconds` */
  private height(seconds: number): number {
    return clamp(0.2 + 1.7 * Math.pow(seconds, 1.25), 0.2, 1.7);
  }

  // ── where is the ball? ─────────────────────────────────────────────────

  /** position at step `s` (cell coords, z in cells). Pure — safe to call for any time. */
  pose(b: Ball, s: number, out: Pose): Pose {
    let hop = b.hop;
    if (hop && s < hop.t0 && b.prev) hop = b.prev;
    if (!hop && b.prev && s < b.prev.t1) hop = b.prev;
    if (!hop) {
      out.x = b.cell.x;
      out.y = b.cell.y;
      out.z = 0;
      return out;
    }
    const k = clamp((s - hop.t0) / (hop.t1 - hop.t0), 0, 1);
    if (hop.free) {
      out.x = hop.a.x + (hop.b.x - hop.a.x) * k;
      out.y = hop.a.y + (hop.b.y - hop.a.y) * k;
      out.z = hop.z0 * (1 - k) * (1 - k) + 4 * hop.h * k * (1 - k);
      return out;
    }
    const ux = hop.u.x + hop.s.x * k;
    const uy = hop.u.y + hop.s.y * k;
    // nudge so the visible path starts and ends dead-centre in a well even
    // when the ideal path (a decaying bounce) lands between them
    const ax = hop.a.x - fold(hop.u.x, W);
    const ay = hop.a.y - fold(hop.u.y, H);
    const bx = hop.b.x - fold(hop.u.x + hop.s.x, W);
    const by = hop.b.y - fold(hop.u.y + hop.s.y, H);
    // the nudge is applied inside the walls, never through them
    out.x = reach(clamp(fold(ux, W) + ax * (1 - k) + bx * k, -0.5, W - 0.5), W, b.edge);
    out.y = reach(clamp(fold(uy, H) + ay * (1 - k) + by * k, -0.5, H - 0.5), H, b.edge);
    out.z = hop.z0 * (1 - k) * (1 - k) + 4 * hop.h * k * (1 - k);
    return out;
  }
}
