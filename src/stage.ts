/**
 * The picture: pads, nests, and the balls + their shadows.
 *
 * The device itself is static DOM/CSS. Only the balls move, and they move
 * with transforms on their own layers, so a frame costs three tiny canvas
 * redraws and six transform writes.
 *
 * ── impact storyboard (per landing) ──────────────────────────────────────
 *    0ms   ball meets the well: swells 10%, shadow snaps tight
 *    0ms   well dips (scale 0.93) and springs back over 300ms
 *   ~140ms ball has rung down through one overshoot
 * ─────────────────────────────────────────────────────────────────────────
 */

import { drawBall, pips, qarc, qaxis, qmul, qnorm, qrot, qslerp } from "./ball-art";
import type { Quat, V3 } from "./ball-art";
import { H, W } from "./engine";
import type { Ball, Engine, Pose } from "./engine";
import { noteName, padSemis } from "./scales";
import type { Scale } from "./scales";

/** radius in design units, pip count */
const LOOKS = [
  { r: 25, pips: 3, dot: 0.15, tilt: [-0.1, 0.12] },
  { r: 19.5, pips: 2, dot: 0.17, tilt: [-0.16, 0.14] },
  { r: 14.5, pips: 1, dot: 0.24, tilt: [-0.2, 0.18] },
];

const LIFT = {
  seat: 0.97, // a resting ball sits a touch into its dimple
  grow: 0.27, // scale gained per cell of height
  maxZ: 2.1,
  shadowX: 0.36, // shadow slides down-right as the ball rises (cells per cell)
  shadowY: 0.5,
};

const SHADE = {
  contact: 0.72, // sprite scale when the ball is sitting (sprite is 3r wide)
  spread: 0.46, // growth per cell of height
  dark: 0.92,
  fade: 2.2,
};

const HOLD = {
  lift: 0.5, // cells above the surface while carried
  rise: 0.045, // s time constant of the pick-up
  reach: 7, // px of slack around a ball when grabbing it
};

const IMPACT = {
  swell: 0.11,
  pinch: 0.2,
  stiffness: 1900, // spring that rings the squash back out
  damping: 30,
  spin: 0.5, // fraction of rolling-without-slipping
  settle: 0.09, // s for the pips to rock face-up once it has stopped
};

/* ── entrance storyboard ──────────────────────────────────────────────────
 *    0ms   slab fades up (css)
 *  300ms   low ball falls into its nest, bounces twice, settles
 *  420ms   mid ball
 *  540ms   high ball
 * Any touch skips it.
 * ───────────────────────────────────────────────────────────────────────── */
const DROP = {
  delay: 0.3, // s before the first ball
  stagger: 0.12, // s between balls
  height: 1.9, // cells it falls from
  fall: 0.3, // s to fall that far
  bounce: 0.4, // restitution
  fade: 0.1, // s to fade in at the top of the fall
};

const DIP: Keyframe[] = [
  { transform: "scale(1)" },
  { transform: "scale(0.93)", offset: 0.14 },
  { transform: "scale(1.012)", offset: 0.55 },
  { transform: "scale(1)" },
];

interface BallView {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  shadow: HTMLElement;
  r: number;
  size: number;
  shadowSize: number;
  q: Quat;
  rest: V3;
  dots: V3[];
  dot: number;
  lx: number;
  ly: number;
  swell: number;
  swellV: number;
  pinch: number;
  pinchV: number;
  nx: number;
  ny: number;
  hopT: number;
  key: string;
  zi: number;
  /** entrance: clock time the ball drops in (-1 once it has landed), impacts so far */
  dropT: number;
  drops: number;
  alpha: number;
  /** extra height while carried in a hand */
  lift: number;
  // this frame
  px: number;
  py: number;
  z: number;
}

export class Stage {
  readonly pads: HTMLButtonElement[] = [];
  readonly homes: HTMLButtonElement[];
  readonly tray: HTMLElement;
  private wells: HTMLElement[] = [];
  private notes: HTMLElement[] = [];
  private nests: HTMLElement[];
  private views: BallView[] = [];
  private device: HTMLElement;
  private pose: Pose = { x: 0, y: 0, z: 0 };
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** px per cell, and the centre of pad (0,0) in device px */
  c = 80;
  x0 = 0;
  y0 = 0;
  private wall = 58;
  private dpr = 1;
  private aimPad = -1;
  private aimBall = -1;

  constructor(private engine: Engine) {
    this.device = document.getElementById("device")!;
    this.tray = document.getElementById("tray")!;
    this.homes = [...document.querySelectorAll<HTMLButtonElement>(".home")];
    this.nests = this.homes.map((h) => h.querySelector<HTMLElement>(".nest")!);

    // pads: DOM order is top row first, index 0 is bottom-left
    const made: HTMLButtonElement[] = [];
    for (let row = H - 1; row >= 0; row--) {
      for (let col = 0; col < W; col++) {
        const pad = document.createElement("button");
        pad.className = "pad";
        pad.dataset.pad = String(row * W + col);
        pad.innerHTML = `<span class="note"></span><span class="well"><i class="aim"></i></span>`;
        this.tray.appendChild(pad);
        made[row * W + col] = pad;
      }
    }
    this.pads.push(...made);
    this.wells = this.pads.map((p) => p.querySelector<HTMLElement>(".well")!);
    this.notes = this.pads.map((p) => p.querySelector<HTMLElement>(".note")!);

    const shadows = document.getElementById("shadows")!;
    const balls = document.getElementById("balls")!;
    for (const look of LOOKS) {
      const shadow = document.createElement("div");
      shadow.className = "shadow";
      shadows.appendChild(shadow);
      const canvas = document.createElement("canvas");
      canvas.className = "ball";
      balls.appendChild(canvas);
      const l = Math.hypot(look.tilt[0], look.tilt[1], 1);
      const rest: V3 = [look.tilt[0] / l, look.tilt[1] / l, -1 / l];
      this.views.push({
        canvas,
        g: canvas.getContext("2d")!,
        shadow,
        r: look.r,
        size: 0,
        shadowSize: 0,
        q: qarc([0, 0, -1], rest),
        rest,
        dots: pips(look.pips),
        dot: look.dot,
        lx: NaN,
        ly: NaN,
        swell: 0,
        swellV: 0,
        pinch: 0,
        pinchV: 0,
        nx: 1,
        ny: 0,
        hopT: -1,
        key: "",
        zi: -1,
        dropT: this.reduced ? -1 : DROP.delay + DROP.stagger * this.views.length,
        drops: 0,
        alpha: -1,
        lift: 0,
        px: 0,
        py: 0,
        z: 0,
      });
    }

    new ResizeObserver(() => this.measure()).observe(this.device);
    this.measure();
  }

  /** read the real geometry back out of the layout so CSS stays the source of truth */
  measure() {
    const dev = this.device.getBoundingClientRect();
    if (dev.width === 0) return;
    const u = dev.width / parseFloat(getComputedStyle(this.device).getPropertyValue("--dw") || "400");
    const centre = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - dev.left, y: r.top + r.height / 2 - dev.top };
    };
    const p0 = centre(this.wells[0]);
    const p1 = centre(this.wells[1]);
    this.c = p1.x - p0.x;
    this.x0 = p0.x;
    this.y0 = p0.y;
    const tray = this.tray.getBoundingClientRect();
    this.wall = p0.x - (tray.left - dev.left);
    this.dpr = Math.min(3, window.devicePixelRatio || 1);

    this.views.forEach((v, i) => {
      const look = LOOKS[i];
      v.r = look.r * u;
      const maxScale = LIFT.seat + LIFT.grow * LIFT.maxZ + IMPACT.swell + 0.04;
      v.size = Math.ceil(v.r * 2 * maxScale + 6);
      v.canvas.width = Math.round(v.size * this.dpr);
      v.canvas.height = Math.round(v.size * this.dpr);
      v.canvas.style.width = v.canvas.style.height = v.size + "px";
      v.shadowSize = Math.ceil(v.r * 3);
      v.shadow.style.width = v.shadow.style.height = v.shadowSize + "px";
      v.key = "";
      v.lx = NaN;

      const b = this.engine.balls[i];
      b.edge = (this.wall - v.r * 0.98) / this.c;
      const h = centre(this.nests[i]);
      this.engine.setHome(i, { x: (h.x - this.x0) / this.c, y: (this.y0 - h.y) / this.c });
    });
  }

  /** which pad is under a client point, with a little slack; -1 if none */
  padAt(clientX: number, clientY: number, slack = 0.5): number {
    const dev = this.device.getBoundingClientRect();
    const fx = (clientX - dev.left - this.x0) / this.c;
    const fy = (this.y0 - (clientY - dev.top)) / this.c;
    const col = Math.round(fx);
    const row = Math.round(fy);
    if (col < 0 || col >= W || row < 0 || row >= H) return -1;
    if (Math.max(Math.abs(fx - col), Math.abs(fy - row)) > slack) return -1;
    return row * W + col;
  }

  setScale(scale: Scale) {
    this.pads.forEach((pad, i) => {
      const semis = padSemis(i % W, Math.floor(i / W), scale);
      const name = noteName(semis);
      this.notes[i].textContent = name;
      this.notes[i].classList.toggle("tonic", semis % 12 === 0);
      pad.setAttribute("aria-label", name + (Math.floor(semis / 12) + 4));
    });
  }

  press(pad: number, down: boolean) {
    this.pads[pad].classList.toggle("down", down);
  }

  /** mark the pad a ball has been sent to; cleared when that ball gets there */
  aim(pad: number, ball = -1) {
    this.aimPad = pad;
    this.aimBall = ball;
    for (let i = 0; i < this.pads.length; i++) this.pads[i].classList.toggle("aimed", i === pad);
  }

  select(id: number) {
    this.homes.forEach((h, i) => h.classList.toggle("on", i === id));
  }

  /** a small acknowledging hop in place */
  nudge(id: number, now: number) {
    this.views[id].hopT = now;
  }

  private dip(el: HTMLElement, power: number) {
    if (this.reduced) return;
    el.animate(DIP, { duration: 240 + 80 * power, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" });
  }

  /** a resting ball under a client point, or -1. Balls in flight cannot be grabbed. */
  ballAt(clientX: number, clientY: number): number {
    const dev = this.device.getBoundingClientRect();
    const x = clientX - dev.left;
    const y = clientY - dev.top;
    let best = -1;
    let bestD = Infinity;
    this.engine.balls.forEach((b, i) => {
      if (b.mode !== "home" && b.mode !== "rest") return;
      const v = this.views[i];
      const d = Math.hypot(x - v.px, y - v.py);
      if (d <= v.r + HOLD.reach && d < bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  /** device px of a ball's centre this frame */
  ballPx(id: number) {
    const dev = this.device.getBoundingClientRect();
    return { x: dev.left + this.views[id].px, y: dev.top + this.views[id].py };
  }

  /** client point → cell coords */
  cellAt(clientX: number, clientY: number) {
    const dev = this.device.getBoundingClientRect();
    return {
      x: (clientX - dev.left - this.x0) / this.c,
      y: (this.y0 - (clientY - dev.top)) / this.c,
    };
  }

  /** hand the carried height over to the engine as the start of a throw */
  letGo(id: number): number {
    const v = this.views[id];
    const z = v.lift;
    v.lift = 0;
    return z;
  }

  /** cancel the entrance (the user is already playing) */
  ready() {
    for (const v of this.views) v.dropT = -1;
  }

  render(sVis: number, now: number, dt: number) {
    const balls = this.engine.balls;
    const views = this.views;
    for (let i = 0; i < balls.length; i++) this.locate(balls[i], views[i], sVis, now, dt);

    // two balls cannot share a dimple: near the ground they nestle side by side
    for (let i = 0; i < views.length; i++) {
      for (let j = i + 1; j < views.length; j++) {
        const a = views[i];
        const b = views[j];
        const near = (1 - Math.min(1, a.z / 0.4)) * (1 - Math.min(1, b.z / 0.4));
        if (near <= 0) continue;
        const min = (a.r + b.r) * 0.94;
        let dx = b.px - a.px;
        let dy = b.py - a.py;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d < 0.5) {
          const ang = 0.5 + (i + j) * 2.1;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          d = 1;
        }
        const push = ((min - Math.hypot(b.px - a.px, b.py - a.py)) * near) / d;
        const wa = b.r / (a.r + b.r);
        a.px -= dx * push * wa;
        a.py -= dy * push * wa;
        b.px += dx * push * (1 - wa);
        b.py += dy * push * (1 - wa);
      }
    }

    for (let i = 0; i < balls.length; i++) this.paint(views[i], dt);
  }

  /** where the ball is this frame, plus everything that happens on the way */
  private locate(b: Ball, v: BallView, sVis: number, now: number, dt: number) {
    const p = this.engine.pose(b, sVis, this.pose);
    v.px = this.x0 + p.x * this.c;
    v.py = this.y0 - p.y * this.c;
    let z = p.z;
    let alpha = 1;

    // picked up: rises off the surface under the finger
    if (b.mode === "held") {
      v.lift += (HOLD.lift - v.lift) * (1 - Math.exp(-dt / HOLD.rise));
      v.dropT = -1;
    }
    z += v.lift;

    // entrance: fall in from above and rattle to rest
    if (v.dropT >= 0) {
      let t = now - v.dropT;
      if (t < 0) {
        alpha = 0;
      } else if (t < DROP.fall) {
        const k = t / DROP.fall;
        z += DROP.height * (1 - k * k);
        alpha = Math.min(1, t / DROP.fade);
      } else {
        t -= DROP.fall;
        let n = 1;
        let dur = 2 * DROP.fall * DROP.bounce;
        while (n <= 3 && t > dur) {
          t -= dur;
          n++;
          dur *= DROP.bounce;
        }
        if (v.drops < Math.min(n, 3)) {
          v.drops = Math.min(n, 3);
          const power = Math.pow(DROP.bounce, n - 1);
          v.swell = IMPACT.swell * power;
          v.swellV = 0;
          this.dip(this.nests[b.id], power);
        }
        if (n > 3) v.dropT = -1;
        else {
          const k = t / dur;
          z += DROP.height * Math.pow(DROP.bounce, 2 * n) * 4 * k * (1 - k);
        }
      }
    }

    // acknowledging hop (visual only)
    if (v.hopT >= 0) {
      const k = (now - v.hopT) / 0.26;
      if (k >= 1) {
        v.hopT = -1;
        v.swell = IMPACT.swell * 0.6;
        v.swellV = 0;
      } else z += 0.36 * 4 * k * (1 - k);
    }
    v.z = Math.min(z, LIFT.maxZ);
    if (alpha !== v.alpha) {
      v.alpha = alpha;
      v.canvas.style.opacity = String(alpha);
    }

    // things that happen when the picture (not the engine) reaches them
    if (b.fx.length) {
      let kept = 0;
      for (let i = 0; i < b.fx.length; i++) {
        const f = b.fx[i];
        if (f.t > sVis) {
          b.fx[kept++] = f;
          continue;
        }
        if (f.kind === "land") {
          v.swell = IMPACT.swell * (0.5 + 0.5 * f.power);
          v.swellV = 0;
          this.dip(this.wells[f.pad], f.power);
          if (f.pad === this.aimPad && b.id === this.aimBall) this.aim(-1);
        } else if (f.kind === "wall") {
          v.pinch = IMPACT.pinch * (0.5 + 0.5 * f.power);
          v.pinchV = 0;
          v.nx = f.nx;
          v.ny = -f.ny;
        } else if (f.kind === "home") {
          v.swell = IMPACT.swell * 0.8;
          v.swellV = 0;
          this.dip(this.nests[b.id], 0.6);
        } else if (f.kind === "settle") {
          v.swell = IMPACT.swell * 0.3;
          v.swellV = 0;
        }
      }
      b.fx.length = kept;
    }
  }

  private paint(v: BallView, dt: number) {
    const px = v.px;
    const py = v.py;
    const z = v.z;
    const air = z > 0.001;

    // squash rings out on a spring
    const step = Math.min(dt, 0.034);
    if (v.swell !== 0 || v.swellV !== 0) {
      v.swellV += (-IMPACT.stiffness * v.swell - IMPACT.damping * v.swellV) * step;
      v.swell += v.swellV * step;
      if (Math.abs(v.swell) < 0.0015 && Math.abs(v.swellV) < 0.05) v.swell = v.swellV = 0;
    }
    if (v.pinch !== 0 || v.pinchV !== 0) {
      v.pinchV += (-IMPACT.stiffness * v.pinch - IMPACT.damping * v.pinchV) * step;
      v.pinch += v.pinchV * step;
      if (Math.abs(v.pinch) < 0.0015 && Math.abs(v.pinchV) < 0.05) v.pinch = v.pinchV = 0;
    }
    const swell = this.reduced ? 0 : v.swell;
    const pinch = this.reduced ? 0 : v.pinch;

    // spin: the ball tumbles with its travel. Pips are printed on both poles,
    // so one set is nearly always in view; when it stops it rocks round until
    // the nearer set faces up. (Which ball is which should never be face-down.)
    if (!Number.isNaN(v.lx)) {
      const dx = px - v.lx;
      const dy = py - v.ly;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.02 && dist < this.c * 2) {
        v.q = qnorm(qmul(qaxis(dy / dist, -dx / dist, 0, (dist / v.r) * IMPACT.spin), v.q));
      } else if (!air && dist <= 0.02) {
        let pole = qrot(v.q, [0, 0, -1]);
        let dot = pole[0] * v.rest[0] + pole[1] * v.rest[1] + pole[2] * v.rest[2];
        if (dot < 0) {
          pole = [-pole[0], -pole[1], -pole[2]];
          dot = -dot;
        }
        if (1 - dot > 0.0002) {
          const goal = qmul(qarc(pole, v.rest), v.q);
          v.q = qslerp(v.q, goal, 1 - Math.exp(-dt / IMPACT.settle));
        }
      }
    }
    v.lx = px;
    v.ly = py;

    // ball
    const scale = LIFT.seat + LIFT.grow * z;
    const half = v.size / 2;
    v.canvas.style.transform = `translate3d(${(px - half).toFixed(2)}px,${(py - half).toFixed(2)}px,0)`;
    const zi = 10 + Math.round(z * 12) + (air ? 4 : 0);
    if (zi !== v.zi) {
      v.zi = zi;
      v.canvas.style.zIndex = String(zi);
    }
    const key =
      scale.toFixed(3) +
      swell.toFixed(3) +
      pinch.toFixed(3) +
      v.q[0].toFixed(3) +
      v.q[1].toFixed(3) +
      v.q[2].toFixed(3);
    if (key !== v.key) {
      v.key = key;
      const g = v.g;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.clearRect(0, 0, v.size, v.size);
      drawBall(g, half, half, v.r * scale, v.q, v.dots, v.dot, {
        swell,
        pinch,
        nx: v.nx,
        ny: v.ny,
      });
    }

    // shadow: tight and dark in contact, sliding away and softening with height
    const sScale = SHADE.contact + SHADE.spread * z + swell * 0.6;
    const sx = px + v.r * 0.14 + z * this.c * LIFT.shadowX - v.shadowSize / 2;
    const sy = py + v.r * 0.2 + z * this.c * LIFT.shadowY - v.shadowSize / 2;
    v.shadow.style.transform = `translate3d(${sx.toFixed(2)}px,${sy.toFixed(2)}px,0) scale(${sScale.toFixed(3)})`;
    v.shadow.style.opacity = ((SHADE.dark * v.alpha) / (1 + SHADE.fade * z)).toFixed(3);
  }
}
