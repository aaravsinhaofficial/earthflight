// Heads-up display: live numbers, warning flags, control-state pills, throttle bar.
import { msToKt, mToFt, msToFpm, wrap360 } from './util.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.e = {
      spd: $('hudSpd'), alt: $('hudAlt'), agl: $('hudAgl'), vs: $('hudVs'),
      hdg: $('hudHdg'), thr: $('hudThr'), aoa: $('hudAoa'), g: $('hudG'),
      stall: $('stallWarn'), gearW: $('gearWarn'), over: $('overWarn'),
      flap: $('flapPill'), gear: $('gearPill'), brake: $('brakePill'),
      park: $('parkPill'), ap: $('apPill'), cam: $('camPill'),
      tqFill: $('tqFill'), tqPct: $('tqPct'), coords: $('tbCoords'), dest: $('hudDest'),
    };
    this._blink = 0;
  }

  updateDest(name, nm, bearing) {
    const el = this.e.dest;
    if (!name) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = `🎯 <b>${name}</b> &nbsp; ${nm.toFixed(nm < 100 ? 1 : 0)} nm &nbsp; brg ${String(Math.round(bearing)).padStart(3, '0')}°`;
  }

  update(fm, camLabel, dt, ap) {
    const e = this.e;
    e.spd.textContent = Math.round(msToKt(fm.ias));  // indicated airspeed (what a real ASI shows)
    e.alt.textContent = Math.round(mToFt(fm.height)).toLocaleString();
    e.agl.textContent = Math.round(mToFt(fm.agl)).toLocaleString();
    e.vs.textContent = (msToFpm(fm.verticalSpeed) >= 0 ? '+' : '') + Math.round(msToFpm(fm.verticalSpeed));
    e.hdg.textContent = String(Math.round(wrap360(fm.headingDeg))).padStart(3, '0');
    e.thr.textContent = Math.round(fm.throttle * 100);
    e.aoa.textContent = fm.aoaDeg.toFixed(1);
    e.g.textContent = fm.loadFactor.toFixed(1);

    // warnings
    this._blink += dt;
    const blinkOn = Math.floor(this._blink * 3) % 2 === 0;
    const stall = fm.stalled || (!fm.onGround && fm.V < fm.ac.stallSpeed * 1.05);
    e.stall.classList.toggle('hidden', !(stall && blinkOn));
    e.gearW.classList.toggle('hidden', !(fm.gearDown === false && fm.agl < 300 && blinkOn));
    // flap / gear over-limit-speed warning (MSFS placard exceedance)
    if (e.over) {
      const over = fm.overspeed ? 'OVERSPEED' : fm.flapOverspeed ? 'FLAP OVERSPEED' : fm.gearOverspeed ? 'GEAR OVERSPEED' : null;
      e.over.textContent = over || '';
      e.over.classList.toggle('hidden', !(over && blinkOn));
    }

    // pills
    e.flap.textContent = `FLAPS ${fm.flapLabel}`;
    e.flap.classList.toggle('pill-on', fm.flapDeg > 0 && !fm.flapOverspeed);
    e.flap.classList.toggle('pill-warn', !!fm.flapOverspeed);
    e.gear.textContent = fm.fixedGear ? 'GEAR FIXED' : (fm.gearDown ? 'GEAR DOWN' : 'GEAR UP');
    e.gear.classList.toggle('pill-on', (fm.gearDown || fm.fixedGear) && !fm.gearOverspeed);
    e.gear.classList.toggle('pill-warn', (!fm.gearDown && !fm.fixedGear) || fm.gearOverspeed);
    e.brake.classList.toggle('pill-on', fm.wheelBrake);
    e.park.textContent = fm.parkingBrake ? 'PARK SET' : 'PARK OFF';
    e.park.classList.toggle('pill-on', fm.parkingBrake);
    if (ap && ap.on) {
      const m = [];
      if (ap.modes.has('NAV')) m.push('NAV'); else if (ap.modes.has('HDG')) m.push('HDG');
      if (ap.modes.has('ALT')) m.push('ALT');
      if (ap.modes.has('SPD')) m.push('SPD');
      e.ap.textContent = 'AP ' + (m.join('·') || 'ON');
      e.ap.classList.add('pill-on');
    } else if (fm.autopilotLevel) {
      e.ap.textContent = 'AP WINGS'; e.ap.classList.add('pill-on');
    } else {
      e.ap.textContent = 'AP OFF'; e.ap.classList.remove('pill-on');
    }
    e.cam.textContent = camLabel;

    // throttle quadrant
    e.tqFill.style.height = `${fm.throttle * 100}%`;
    e.tqPct.textContent = `${Math.round(fm.throttle * 100)}%`;

    // coords
    const c = fm.cartographicDeg;
    e.coords.textContent = `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}  ·  ${Math.round(mToFt(fm.height)).toLocaleString()} ft`;
  }
}
