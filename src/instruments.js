// SVG flight instruments — the classic six-pack. Each gauge builds its face once
// and only nudges needle transforms on update (cheap, smooth).
import { clamp, wrap360, msToKt, mToFt, msToFpm } from './util.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function svgRoot(host, title) {
  host.innerHTML = '';
  const svg = el('svg', { viewBox: '0 0 100 100' }, host);
  el('circle', { cx: 50, cy: 50, r: 49, fill: '#0a0d12', stroke: '#2a3240', 'stroke-width': 1.5 }, svg);
  el('circle', { cx: 50, cy: 50, r: 45, fill: '#11161e', stroke: '#000', 'stroke-width': 0.5 }, svg);
  const lbl = el('text', { x: 50, y: 88, 'text-anchor': 'middle', fill: '#5d6b7d', 'font-size': 6, 'font-family': 'monospace' }, svg);
  lbl.textContent = title;
  return svg;
}

const polar = (cx, cy, r, deg) => {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};

// Generic round gauge with ticks + one needle, value→angle mapping.
function dialGauge(host, { title, min, max, a0, a1, step, label, unit, color = '#d7e3f0', redline }) {
  const svg = svgRoot(host, title);
  const span = a1 - a0, vspan = max - min;
  for (let val = min; val <= max + 1e-6; val += step) {
    const ang = a0 + (val - min) / vspan * span;
    const [x1, y1] = polar(50, 50, 42, ang);
    const [x2, y2] = polar(50, 50, 36, ang);
    el('line', { x1, y1, x2, y2, stroke: '#7d8da0', 'stroke-width': 1 }, svg);
    const [tx, ty] = polar(50, 50, 30, ang);
    const t = el('text', { x: tx, y: ty + 2, 'text-anchor': 'middle', fill: '#9fb0c4', 'font-size': 5.2, 'font-family': 'monospace' }, svg);
    t.textContent = label ? label(val) : val;
  }
  if (redline !== undefined) {
    const ang = a0 + (redline - min) / vspan * span;
    const [x1, y1] = polar(50, 50, 42, ang);
    const [x2, y2] = polar(50, 50, 34, ang);
    el('line', { x1, y1, x2, y2, stroke: '#ff4040', 'stroke-width': 2 }, svg);
  }
  const needle = el('line', { x1: 50, y1: 54, x2: 50, y2: 14, stroke: color, 'stroke-width': 2.4, 'stroke-linecap': 'round' }, svg);
  el('circle', { cx: 50, cy: 50, r: 3, fill: '#cdd8e6' }, svg);
  const digital = el('text', { x: 50, y: 68, 'text-anchor': 'middle', fill: color, 'font-size': 8, 'font-family': 'monospace', 'font-weight': 'bold' }, svg);
  return {
    set(val, digitalText) {
      const ang = a0 + (clamp(val, min, max) - min) / vspan * span;
      needle.setAttribute('transform', `rotate(${ang} 50 50)`);
      if (digitalText !== undefined) digital.textContent = digitalText;
    },
  };
}

export class Instruments {
  constructor() {
    this.asi = dialGauge(document.getElementById('g-asi'), {
      title: 'AIRSPEED kt', min: 0, max: 200, a0: -135, a1: 135, step: 20,
    });
    this.alt = dialGauge(document.getElementById('g-alt'), {
      title: 'ALT x100 ft', min: 0, max: 1000, a0: -180, a1: 180, step: 100,
      label: (v) => (v / 100) % 10,
    });
    this.vsi = dialGauge(document.getElementById('g-vsi'), {
      title: 'VS x1000 fpm', min: -2, max: 2, a0: -135, a1: 135, step: 1, color: '#9fe6b0',
    });
    this.turn = dialGauge(document.getElementById('g-turn'), {
      title: 'TURN / BANK', min: -60, max: 60, a0: -90, a1: 90, step: 30, color: '#ffd479',
    });
    this._buildAttitude();
    this._buildHeading();
  }

  _buildAttitude() {
    const host = document.getElementById('g-attitude');
    host.innerHTML = '';
    const svg = el('svg', { viewBox: '0 0 100 100' }, host);
    const clip = el('clipPath', { id: 'adiClip' }, svg);
    el('circle', { cx: 50, cy: 50, r: 44 }, clip);
    const g = el('g', { 'clip-path': 'url(#adiClip)' }, svg);
    this.adiRoll = el('g', {}, g);          // rolls with bank
    this.adiPitch = el('g', {}, this.adiRoll); // translates with pitch
    // sky & ground (oversized so they cover during pitch/roll)
    el('rect', { x: -60, y: -120, width: 220, height: 170, fill: '#3da4e0' }, this.adiPitch);
    el('rect', { x: -60, y: 50, width: 220, height: 170, fill: '#8a5a2b' }, this.adiPitch);
    el('line', { x1: -60, y1: 50, x2: 160, y2: 50, stroke: '#fff', 'stroke-width': 1 }, this.adiPitch);
    // pitch ladder
    for (let p = -30; p <= 30; p += 10) {
      if (p === 0) continue;
      const y = 50 - p * 1.4;
      el('line', { x1: 38, y1: y, x2: 62, y2: y, stroke: '#fff', 'stroke-width': 0.6 }, this.adiPitch);
      const t = el('text', { x: 34, y: y + 2, fill: '#fff', 'font-size': 4, 'text-anchor': 'end', 'font-family': 'monospace' }, this.adiPitch);
      t.textContent = Math.abs(p);
    }
    // fixed bank pointer & aircraft symbol
    el('circle', { cx: 50, cy: 50, r: 44, fill: 'none', stroke: '#2a3240', 'stroke-width': 3 }, svg);
    el('path', { d: 'M30 50 L44 50 M56 50 L70 50 M50 50 l0 0', stroke: '#ffcf3f', 'stroke-width': 2.2, 'stroke-linecap': 'round' }, svg);
    el('circle', { cx: 50, cy: 50, r: 1.6, fill: '#ffcf3f' }, svg);
    el('path', { d: 'M50 6 l-3 6 l6 0 z', fill: '#ffcf3f' }, svg);
    const t = el('text', { x: 50, y: 92, 'text-anchor': 'middle', fill: '#5d6b7d', 'font-size': 5.5, 'font-family': 'monospace' }, svg);
    t.textContent = 'ATTITUDE';
  }

  _buildHeading() {
    const host = document.getElementById('g-heading');
    const svg = svgRoot(host, 'HEADING');
    this.hdgCard = el('g', {}, svg);
    for (let d = 0; d < 360; d += 10) {
      const major = d % 30 === 0;
      const [x1, y1] = polar(50, 50, 42, d);
      const [x2, y2] = polar(50, 50, major ? 34 : 38, d);
      el('line', { x1, y1, x2, y2, stroke: '#9fb0c4', 'stroke-width': major ? 1 : 0.5 }, this.hdgCard);
      if (major) {
        const [tx, ty] = polar(50, 50, 28, d);
        const t = el('text', { x: tx, y: ty + 2, 'text-anchor': 'middle', fill: '#cdd8e6', 'font-size': 5.5, 'font-family': 'monospace' }, this.hdgCard);
        t.textContent = ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' })[d] ?? (d / 10);
      }
    }
    // fixed lubber line + aircraft
    el('path', { d: 'M50 6 l-3 6 l6 0 z', fill: '#ffcf3f' }, svg);
    el('path', { d: 'M50 40 l0 20 M44 46 l12 0 M46 58 l8 0', stroke: '#fff', 'stroke-width': 1.4, fill: 'none', 'stroke-linecap': 'round' }, svg);
    this.hdgDigital = el('text', { x: 50, y: 74, 'text-anchor': 'middle', fill: '#fff', 'font-size': 8, 'font-family': 'monospace', 'font-weight': 'bold' }, svg);
  }

  update(fm) {
    const kt = msToKt(fm.V);
    this.asi.set(kt, Math.round(kt).toString());

    const ft = mToFt(fm.height);
    this.alt.set(ft % 1000, Math.round(ft).toLocaleString());

    this.vsi.set(clamp(msToFpm(fm.verticalSpeed) / 1000, -2, 2), Math.round(msToFpm(fm.verticalSpeed)).toString());

    const rollDeg = fm.roll * 180 / Math.PI;
    this.turn.set(clamp(rollDeg, -60, 60));

    // attitude: roll the whole card, slide the pitch group
    this.adiRoll.setAttribute('transform', `rotate(${-rollDeg} 50 50)`);
    this.adiPitch.setAttribute('transform', `translate(0 ${fm.pitch * 180 / Math.PI * 1.4})`);

    // heading card rotates opposite to heading; lubber stays at top
    const hdg = fm.headingDeg;
    this.hdgCard.setAttribute('transform', `rotate(${-hdg} 50 50)`);
    this.hdgDigital.textContent = String(Math.round(wrap360(hdg))).padStart(3, '0');
  }
}
