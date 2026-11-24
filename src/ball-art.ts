/**
 * Drawing the hero object: a matte rubber ball with yellow pips, lit from
 * the upper left, that really rotates as it travels.
 *
 * Frame: x right, y down, z into the screen. The camera looks down +z, so
 * the visible hemisphere is z < 0.
 */

export type Quat = [number, number, number, number]; // x y z w
export type V3 = [number, number, number];

export const SIGNAL = "#ffc400";

export function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function qaxis(x: number, y: number, z: number, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

export function qnorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function qrot(q: Quat, v: V3): V3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

/** shortest rotation taking unit vector a to unit vector b */
export function qarc(a: V3, b: V3): Quat {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.9999) return [1, 0, 0, 0];
  return qnorm([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
    1 + d,
  ]);
}

export function qslerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) {
    d = -d;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (d > 0.9995) {
    return qnorm([
      a[0] + (bb[0] - a[0]) * t,
      a[1] + (bb[1] - a[1]) * t,
      a[2] + (bb[2] - a[2]) * t,
      a[3] + (bb[3] - a[3]) * t,
    ]);
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [
    a[0] * wa + bb[0] * wb,
    a[1] * wa + bb[1] * wb,
    a[2] * wa + bb[2] * wb,
    a[3] * wa + bb[3] * wb,
  ];
}

/** n pips clustered round the ball's pole (which faces the camera at rest) */
export function pips(n: number): V3[] {
  if (n === 1) return [[0, 0, -1]];
  const spread = n === 2 ? 0.25 : 0.3;
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (n === 2 ? 0 : -Math.PI / 2);
    const x = Math.cos(a) * spread;
    const y = Math.sin(a) * spread;
    const l = Math.hypot(x, y, 1);
    out.push([x / l, y / l, -1 / l]);
  }
  return out;
}

export interface Squash {
  /** uniform swell (ball flattening toward the camera reads as getting wider) */
  swell: number;
  /** directional squeeze against a wall, along (nx, ny) */
  pinch: number;
  nx: number;
  ny: number;
}

/**
 * @param g     2d context, already scaled so 1 unit = 1 css px
 * @param cx,cy centre
 * @param r     radius in css px
 */
export function drawBall(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  q: Quat,
  dots: V3[],
  dotSize: number,
  sq: Squash,
) {
  g.save();
  g.translate(cx, cy);
  if (sq.pinch !== 0) {
    const a = Math.atan2(sq.ny, sq.nx);
    g.rotate(a);
    g.scale(1 - sq.pinch, 1 + sq.pinch * 0.5);
    g.rotate(-a);
  }
  const R = r * (1 + sq.swell);

  // body
  g.beginPath();
  g.arc(0, 0, R, 0, Math.PI * 2);
  g.fillStyle = "#1b1b1d";
  g.fill();
  g.clip();

  // seam: a great circle, so you can read the spin even with the pips hidden
  const n = qrot(q, [1, 0, 0]);
  const u = qrot(q, [0, 1, 0]);
  const v = qrot(q, [0, 0, 1]);
  g.beginPath();
  let pen = false;
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const z = u[2] * c + v[2] * s;
    if (z > 0.02) {
      pen = false;
      continue;
    }
    const x = (u[0] * c + v[0] * s) * R;
    const y = (u[1] * c + v[1] * s) * R;
    if (pen) g.lineTo(x, y);
    else g.moveTo(x, y);
    pen = true;
  }
  void n;
  g.lineWidth = Math.max(0.6, R * 0.035);
  g.strokeStyle = "rgba(255,255,255,0.075)";
  g.stroke();

  // pips, foreshortened toward the limb
  g.fillStyle = SIGNAL;
  for (const d of dots) {
    const p = qrot(q, d);
    const depth = -p[2];
    if (depth <= 0.03) continue;
    g.globalAlpha = Math.min(1, depth * 5);
    g.beginPath();
    g.ellipse(
      p[0] * R,
      p[1] * R,
      Math.max(0.3, dotSize * R * depth),
      dotSize * R,
      Math.atan2(p[1], p[0]),
      0,
      Math.PI * 2,
    );
    g.fill();
  }
  g.globalAlpha = 1;

  // form shading over body + pips: key light upper-left, falloff to the limb
  let grad = g.createRadialGradient(-R * 0.36, -R * 0.42, R * 0.05, -R * 0.1, -R * 0.12, R * 1.12);
  grad.addColorStop(0, "rgba(255,255,255,0.20)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.06)");
  grad.addColorStop(0.62, "rgba(0,0,0,0.10)");
  grad.addColorStop(1, "rgba(0,0,0,0.62)");
  g.fillStyle = grad;
  g.fillRect(-R, -R, R * 2, R * 2);

  // light bounced back off the pale surface, lower right
  grad = g.createRadialGradient(R * 0.62, R * 0.78, 0, R * 0.62, R * 0.78, R * 0.85);
  grad.addColorStop(0, "rgba(235,228,214,0.22)");
  grad.addColorStop(1, "rgba(235,228,214,0)");
  g.fillStyle = grad;
  g.fillRect(-R, -R, R * 2, R * 2);

  // broad matte highlight
  grad = g.createRadialGradient(-R * 0.4, -R * 0.46, 0, -R * 0.4, -R * 0.46, R * 0.42);
  grad.addColorStop(0, "rgba(255,255,255,0.26)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(-R, -R, R * 2, R * 2);

  g.restore();
}
