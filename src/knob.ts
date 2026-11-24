/**
 * A chunky knob. Drag up or right to turn it; wheel, arrow keys and
 * double-click-to-reset also work. Stepped knobs click between detents.
 */

const SWEEP = 270; // degrees of travel
const TRAVEL = 190; // px of drag for the full sweep

export interface KnobOptions {
  label: string;
  value: number; // 0..1
  steps?: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}

export class Knob {
  value: number;
  readonly el: HTMLElement;
  private dial: HTMLElement;
  private grip: HTMLElement;
  private knob: HTMLElement;
  private val: HTMLElement;
  private lbl: HTMLElement;
  private timer = 0;

  constructor(parent: HTMLElement, private opts: KnobOptions) {
    this.value = opts.value;
    const steps = opts.steps ?? 0;
    const ticks = steps
      ? Array.from({ length: steps }, (_, i) => i / (steps - 1))
      : [0, 0.25, 0.5, 0.75, 1];
    this.el = document.createElement("div");
    this.el.className = "ctl";
    this.el.innerHTML = `
      <div class="knob${steps ? " stepped" : ""}" role="slider" tabindex="0" aria-label="${opts.label}"
           aria-valuemin="0" aria-valuemax="100">
        ${ticks.map((t) => `<i class="tick" style="--a:${(t - 0.5) * SWEEP}deg"></i>`).join("")}
        <span class="knob-shade"></span>
        <span class="knob-body">
          <span class="knob-grip"></span>
          <span class="knob-face"></span>
          <span class="knob-dial"><i class="knob-pip"></i></span>
        </span>
      </div>
      <span class="lbl"><span class="lbl-name">${opts.label}</span><span class="lbl-val"></span></span>`;
    parent.appendChild(this.el);
    this.knob = this.el.querySelector<HTMLElement>(".knob")!;
    this.dial = this.el.querySelector<HTMLElement>(".knob-dial")!;
    this.grip = this.el.querySelector<HTMLElement>(".knob-grip")!;
    this.val = this.el.querySelector<HTMLElement>(".lbl-val")!;
    this.lbl = this.el.querySelector<HTMLElement>(".lbl")!;
    this.paint();
    this.bind();
  }

  private snap(v: number): number {
    v = Math.min(1, Math.max(0, v));
    const n = this.opts.steps;
    return n ? Math.round(v * (n - 1)) / (n - 1) : v;
  }

  set(v: number, show = true) {
    v = this.snap(v);
    if (v === this.value) return;
    this.value = v;
    this.paint();
    this.opts.onChange(v);
    if (show) this.flash();
  }

  private paint() {
    const deg = (this.value - 0.5) * SWEEP;
    this.dial.style.transform = this.grip.style.transform = `rotate(${deg.toFixed(2)}deg)`;
    const text = this.opts.format(this.value);
    this.val.textContent = text;
    this.knob.setAttribute("aria-valuenow", String(Math.round(this.value * 100)));
    this.knob.setAttribute("aria-valuetext", text);
  }

  /** the label briefly reads out the value, then goes back to its name */
  private flash() {
    this.lbl.classList.add("show");
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.lbl.classList.remove("show"), 900);
  }

  private bind() {
    const k = this.knob;
    let id = -1;
    let startX = 0;
    let startY = 0;
    let startV = 0;
    let raw = 0;

    k.addEventListener("pointerdown", (e) => {
      if (id !== -1) return;
      id = e.pointerId;
      k.setPointerCapture(id);
      startX = e.clientX;
      startY = e.clientY;
      startV = raw = this.value;
      k.classList.add("held");
      this.flash();
    });
    k.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id) return;
      const d = e.clientX - startX - (e.clientY - startY);
      raw = startV + d / (TRAVEL * (e.shiftKey ? 4 : 1));
      this.set(raw);
      this.flash();
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      k.classList.remove("held");
    };
    k.addEventListener("pointerup", end);
    k.addEventListener("pointercancel", end);

    k.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const n = this.opts.steps;
        if (n) this.set(this.value + (e.deltaY < 0 ? 1 : -1) / (n - 1));
        else this.set(this.value - e.deltaY * 0.0012);
      },
      { passive: false },
    );

    k.addEventListener("dblclick", () => this.set(this.opts.value));

    k.addEventListener("keydown", (e) => {
      const n = this.opts.steps;
      const inc = n ? 1 / (n - 1) : e.shiftKey ? 0.01 : 0.04;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") this.set(this.value + inc);
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") this.set(this.value - inc);
      else if (e.key === "Home") this.set(0);
      else if (e.key === "End") this.set(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
}
