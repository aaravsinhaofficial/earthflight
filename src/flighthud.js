// Head-up display overlay (the "HUD view"): a glass-HUD with pitch ladder, bank
// pointer, heading/speed/altitude tapes, and a flight-path marker — drawn in
// screen space and aligned to the real horizon via the camera's vertical FOV.
import { clamp, wrap360, msToKt, mToFt, msToFpm } from './util.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const GREEN = '#54ffb0';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

export class FlightHud {
  constructor() {
    this.svg = el('svg', { id: 'flightHud', class: 'flight-hud hidden' });
    document.body.appendChild(this.svg);
    this.W = 0; this.H = 0;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    this.W = window.innerWidth; this.H = window.innerHeight;
    this.svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    this._build();
  }

  setVisible(v) { this.svg.classList.toggle('hidden', !v); }

  _build() {
    const W = this.W, H = this.H, cx = W / 2, cy = H / 2;
    this.svg.innerHTML = '';
    const stroke = { stroke: GREEN, fill: 'none', 'stroke-width': 2 };

    // boresight (fixed aircraft reference)
    const bs = el('g', {}, this.svg);
    el('path', { d: `M${cx - 60} ${cy} h34 l8 10 l8 -10 h34`, ...stroke }, bs);
    el('circle', { cx, cy, r: 3, fill: GREEN }, bs);

    // pitch-ladder group (clipped to a central window)
    const clip = el('clipPath', { id: 'hudClip' }, this.svg);
    el('rect', { x: cx - W * 0.27, y: cy - H * 0.33, width: W * 0.54, height: H * 0.66 }, clip);
    this.ladder = el('g', { 'clip-path': 'url(#hudClip)' }, this.svg);
    this.ladderInner = el('g', {}, this.ladder);

    // flight-path marker
    this.fpv = el('g', {}, this.svg);
    el('circle', { cx: 0, cy: 0, r: 9, ...stroke }, this.fpv);
    el('path', { d: 'M-9 0 h-12 M9 0 h12 M0 -9 v-7', ...stroke }, this.fpv);

    // bank pointer arc (top)
    const arc = el('g', {}, this.svg);
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const r1 = H * 0.34, r2 = r1 + (a % 30 === 0 ? 16 : 9);
      const rad = (a - 90) * Math.PI / 180;
      el('line', { x1: cx + r1 * Math.cos(rad), y1: cy + r1 * Math.sin(rad), x2: cx + r2 * Math.cos(rad), y2: cy + r2 * Math.sin(rad), stroke: GREEN, 'stroke-width': 1.5 }, arc);
    }
    this.bankPtr = el('path', { d: `M${cx} ${cy - H * 0.34 + 2} l-7 -12 l14 0 z`, fill: GREEN }, this.svg);

    // tapes
    this.spdTape = el('g', {}, this.svg);
    this.altTape = el('g', {}, this.svg);
    this.hdgTape = el('g', {}, this.svg);
    this.spdBox = this._box(cx - W * 0.30, cy, 'right');
    this.altBox = this._box(cx + W * 0.30, cy, 'left');
    this.hdgBox = this._box(cx, cy - H * 0.36, 'center');

    // bottom readouts
    this.readout = el('text', { x: cx - W * 0.30, y: cy + H * 0.30, fill: GREEN, 'font-family': 'ui-monospace, monospace', 'font-size': 16 }, this.svg);
    this.readout2 = el('text', { x: cx + W * 0.30, y: cy + H * 0.30, fill: GREEN, 'font-family': 'ui-monospace, monospace', 'font-size': 16, 'text-anchor': 'end' }, this.svg);
    this.warn = el('text', { x: cx, y: cy + H * 0.18, fill: '#ff5a3c', 'font-family': 'ui-monospace, monospace', 'font-size': 26, 'font-weight': 'bold', 'text-anchor': 'middle' }, this.svg);
  }

  _box(x, y, anchor) {
    const g = el('g', {}, this.svg);
    const w = 78, h = 26;
    const bx = anchor === 'right' ? x - w : anchor === 'center' ? x - w / 2 : x;
    el('rect', { x: bx, y: y - h / 2, width: w, height: h, fill: 'rgba(0,0,0,0.35)', stroke: GREEN, 'stroke-width': 1.5 }, g);
    const t = el('text', { x: anchor === 'right' ? x - 8 : anchor === 'center' ? x : x + 8, y: y + 6, fill: GREEN, 'font-family': 'ui-monospace, monospace', 'font-size': 18, 'font-weight': 'bold', 'text-anchor': anchor === 'right' ? 'end' : anchor === 'center' ? 'middle' : 'start' }, g);
    return t;
  }

  update(fm, fovyDeg) {
    const W = this.W, H = this.H, cx = W / 2, cy = H / 2;
    const DEG = Math.PI / 180;
    const pxPerDeg = H / (fovyDeg || 50);
    const pitchDeg = fm.pitch / DEG, rollDeg = fm.roll / DEG;

    // ---- pitch ladder: translate by pitch, rotate by -roll ----
    this.ladderInner.innerHTML = '';
    const drawBar = (ang) => {
      const y = ang * pxPerDeg;        // +ang above horizon (screen up = -y)
      const sy = -y;
      const grp = this.ladderInner;
      const gap = ang === 0 ? 0 : 24, len = ang === 0 ? 150 : 60;
      const dash = ang < 0 ? '8 8' : '0';
      el('line', { x1: -len, y1: sy, x2: -gap, y2: sy, stroke: GREEN, 'stroke-width': 2, 'stroke-dasharray': dash }, grp);
      el('line', { x1: gap, y1: sy, x2: len, y2: sy, stroke: GREEN, 'stroke-width': 2, 'stroke-dasharray': dash }, grp);
      if (ang !== 0) {
        // little down-ticks on the ends pointing to the horizon
        const tick = ang > 0 ? 8 : -8;
        el('line', { x1: -len, y1: sy, x2: -len, y2: sy + tick, stroke: GREEN, 'stroke-width': 2 }, grp);
        el('line', { x1: len, y1: sy, x2: len, y2: sy + tick, stroke: GREEN, 'stroke-width': 2 }, grp);
        for (const xx of [-len - 6, len + 6]) {
          const t = el('text', { x: xx, y: sy + 5, fill: GREEN, 'font-family': 'ui-monospace, monospace', 'font-size': 13, 'text-anchor': xx < 0 ? 'end' : 'start' }, grp);
          t.textContent = Math.abs(ang);
        }
      }
    };
    for (let a = -30; a <= 30; a += 5) drawBar(a);
    this.ladderInner.setAttribute('transform', `translate(0 ${pitchDeg * pxPerDeg})`);
    this.ladder.setAttribute('transform', `translate(${cx} ${cy}) rotate(${-rollDeg})`);

    // ---- flight-path marker (offset by AoA / sideslip) ----
    const fx = cx - (fm.beta / DEG) * pxPerDeg;
    const fy = cy + (fm.aoaDeg) * pxPerDeg;
    this.fpv.setAttribute('transform', `translate(${clamp(fx, cx - 150, cx + 150)} ${clamp(fy, cy - 150, cy + 150)})`);

    // ---- bank pointer ----
    this.bankPtr.setAttribute('transform', `rotate(${rollDeg} ${cx} ${cy})`);

    // ---- tapes ----
    const kt = msToKt(fm.V), alt = mToFt(fm.height), hdg = wrap360(fm.headingDeg);
    this._vtape(this.spdTape, cx - W * 0.30, cy, kt, 10, 1, false);
    this._vtape(this.altTape, cx + W * 0.30, cy, alt, 100, 0.1, true);
    this._htape(this.hdgTape, cx, cy - H * 0.36, hdg);
    this.spdBox.textContent = Math.round(kt);
    this.altBox.textContent = Math.round(alt).toLocaleString();
    this.hdgBox.textContent = String(Math.round(hdg)).padStart(3, '0');

    this.readout.textContent = `G ${fm.loadFactor.toFixed(1)}   AOA ${fm.aoaDeg.toFixed(0)}`;
    this.readout2.textContent = `THR ${Math.round(fm.throttle * 100)}%   ${msToFpm(fm.verticalSpeed) >= 0 ? '+' : ''}${Math.round(msToFpm(fm.verticalSpeed))} fpm`;
    const stall = fm.stalled || (!fm.onGround && fm.V < fm.ac.stallSpeed * 1.05);
    this.warn.textContent = stall ? 'STALL' : '';
  }

  // vertical sliding tape (speed/altitude)
  _vtape(g, x, cy, value, step, unitsPerStep, right) {
    g.innerHTML = '';
    const H = this.H, pxPer = 3.2 / unitsPerStep / 10 * step; // px per unit
    const half = H * 0.28;
    const lo = value - half / pxPer, hi = value + half / pxPer;
    const first = Math.ceil(lo / step) * step;
    for (let v = first; v <= hi; v += step) {
      const y = cy - (v - value) * pxPer;
      const major = (v / step) % 5 === 0;
      const tx = right ? x + 8 : x - 8;
      const len = major ? 14 : 7;
      el('line', { x1: right ? x : x, y1: y, x2: right ? x + len : x - len, y2: y, stroke: GREEN, 'stroke-width': major ? 1.6 : 1 }, g);
      if (major) {
        const t = el('text', { x: right ? x + len + 4 : x - len - 4, y: y + 4, fill: GREEN, 'font-family': 'ui-monospace, monospace', 'font-size': 12, 'text-anchor': right ? 'start' : 'end' }, g);
        t.textContent = Math.round(v).toLocaleString();
      }
    }
    el('line', { x1: x, y1: cy - half, x2: x, y2: cy + half, stroke: GREEN, 'stroke-width': 1.5, opacity: 0.5 }, g);
  }

  // horizontal heading tape
  _htape(g, cx, y, hdg) {
    g.innerHTML = '';
    const W = this.W, pxPer = (W * 0.5) / 60; // 60° across
    for (let d = -40; d <= 40; d += 5) {
      const h = wrap360(hdg + d);
      const x = cx + d * pxPer;
      const major = Math.round(h) % 10 === 0;
      el('line', { x1: x, y1: y - 20, x2: x, y2: y - (major ? 30 : 25), stroke: GREEN, 'stroke-width': major ? 1.6 : 1 }, g);
      if (Math.round(h) % 30 === 0) {
        const lbl = ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' })[Math.round(h) % 360] ?? Math.round(h / 10);
        const t = el('text', { x, y: y - 34, fill: GREEN, 'font-family': 'ui-monospace, monospace', 'font-size': 13, 'text-anchor': 'middle' }, g);
        t.textContent = lbl;
      }
    }
  }
}
