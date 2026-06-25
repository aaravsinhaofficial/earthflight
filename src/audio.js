// Procedural flight audio (Web Audio API) — engine (prop chop vs turbofan whine),
// airflow, and event sounds (stall horn, overspeed clacker, gear/flap motors,
// touchdown thunk, tire rumble). All synthesized, no files. Everything keys off
// the ACTUAL delivered thrust (fm.thrustFrac, spool-lagged) and indicated airspeed,
// so the sound matches the physics. Lazily started on the first user gesture.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.started = false;
    this._volume = 0.7;
    // edge/continuous-state trackers
    this._stallOn = false; this._clackOn = false; this._clackNext = 0;
    this._prevGear = 1; this._prevFlap = 0; this._lastTd = null;
  }

  // ── tiny node helpers ──
  _gain(v) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  _filter(type, freq, q, gain) {
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    if (q != null) f.Q.value = q; if (gain != null) f.gain.value = gain;
    return f;
  }
  _noiseSrc() {  // a looping white-noise source on the shared buffer (started in start())
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true; s.start();
    return s;
  }
  _wave(imag) { // PeriodicWave from a list of sine-harmonic amplitudes ([0]=DC unused)
    const real = new Float32Array(imag.length);
    return this.ctx.createPeriodicWave(real, Float32Array.from(imag), { disableNormalization: false });
  }

  start() {
    if (this.started || !this.enabled) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      const ctx = this.ctx;

      // shared 2 s white-noise buffer (reused by every noise voice)
      this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const nd = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

      // master → brick-wall compressor → out (the clip safety net)
      this.master = this._gain(this.enabled ? this._volume : 0);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -6; comp.knee.value = 6; comp.ratio.value = 12;
      comp.attack.value = 0.003; comp.release.value = 0.2;
      this.master.connect(comp).connect(ctx.destination);

      // category busses
      this.busEngine = this._gain(0.85); this.busEngine.connect(this.master);
      this.busWind   = this._gain(0.7);  this.busWind.connect(this.master);
      this.busWarn   = this._gain(0.7);  this.busWarn.connect(this.master);
      this.busMech   = this._gain(0.55); this.busMech.connect(this.master);
      this.busRoll   = this._gain(0.6);  this.busRoll.connect(this.master);

      this._buildPiston();
      this._buildTurbofan();
      this._buildWind();
      this._buildStall();
      this._buildGear();
      this._buildFlap();
      this._buildRoll();

      this.started = true;
    } catch (e) {
      console.warn('Audio unavailable', e);
      this.enabled = false;
    }
  }

  // ── PISTON-PROP chain (Cherokee "chop": harmonic stack + rasp shaper + slow throb) ──
  _buildPiston() {
    const ctx = this.ctx;
    this.propOsc = ctx.createOscillator();
    this.propOsc.setPeriodicWave(this._wave([0, 0.30, 1.0, 0.65, 0.50, 0.35, 0.22, 0.14, 0.09]));
    this.propOsc.frequency.value = 46;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = i / 255 * 2 - 1; curve[i] = Math.tanh(2.2 * x) - 0.15 * x * x; }
    shaper.curve = curve; shaper.oversample = '2x';
    this.propLP = this._filter('lowpass', 1200, 0.7);
    const peak = this._filter('peaking', 220, 1.2, 6);
    this.propAM = this._gain(1.0);
    this.engPistonGain = this._gain(0.1);          // inner level (per-frame from thrust)
    this.pistonGain = this._gain(0);               // chain select (crossfade 0/1)
    this.propOsc.connect(shaper).connect(this.propLP).connect(peak).connect(this.propAM);
    this.propAM.connect(this.engPistonGain).connect(this.pistonGain).connect(this.busEngine);
    // slow amplitude throb (one pulse per crank rev)
    this.amLFO = ctx.createOscillator(); this.amLFO.type = 'sine'; this.amLFO.frequency.value = 11;
    const amDepth = this._gain(0.12);
    this.amLFO.connect(amDepth).connect(this.propAM.gain);
    // combustion roughness
    this.exhaustBP = this._filter('bandpass', 400, 0.5);
    this.exhaustGain = this._gain(0.02);
    this._noiseSrc().connect(this.exhaustBP).connect(this.exhaustGain).connect(this.engPistonGain);
    this.propOsc.start(); this.amLFO.start();
  }

  // ── TURBOFAN chain (CFM56: combustion rumble + spool hiss + fan whine + buzzsaw) ──
  _buildTurbofan() {
    const ctx = this.ctx;
    // A) low combustion rumble
    this.rumbleLP = this._filter('lowpass', 160, 0.7);
    this.rumbleGain = this._gain(0.06);
    this._noiseSrc().connect(this.rumbleLP).connect(this.rumbleGain);
    const rumbleLFO = ctx.createOscillator(); rumbleLFO.type = 'sine'; rumbleLFO.frequency.value = 7;
    const rumbleLfoG = this._gain(0.012); rumbleLFO.connect(rumbleLfoG).connect(this.rumbleGain.gain); rumbleLFO.start();
    // B) mid spool hiss
    this.spoolBP = this._filter('bandpass', 1000, 0.8);
    this.spoolGain = this._gain(0.05);
    this._noiseSrc().connect(this.spoolBP).connect(this.spoolGain);
    // C) fan whine (blade-pass tone) + buzzsaw (shaft harmonics, takeoff only)
    this.whineOsc = ctx.createOscillator();
    this.whineOsc.setPeriodicWave(this._wave([0, 1.0, 0.25, 0.12]));
    this.whineOsc.frequency.value = 1200;
    const whinePeak = this._filter('peaking', 2200, 4, 8);
    this.whineGain = this._gain(0);
    this.whineOsc.connect(whinePeak).connect(this.whineGain);
    this.buzzOsc = ctx.createOscillator();
    const bz = [0]; for (let k = 1; k <= 16; k++) bz[k] = 0.7 / k;
    this.buzzOsc.setPeriodicWave(this._wave(bz));
    this.buzzOsc.frequency.value = 50;
    const buzzHP = this._filter('highpass', 500, 0.7);
    this.buzzGain = this._gain(0);
    this.buzzOsc.connect(buzzHP).connect(this.buzzGain);
    // sum the four layers → chain select
    this.turbineGain = this._gain(0);
    this.rumbleGain.connect(this.turbineGain);
    this.spoolGain.connect(this.turbineGain);
    this.whineGain.connect(this.turbineGain);
    this.buzzGain.connect(this.turbineGain);
    this.turbineGain.connect(this.busEngine);
    this.whineOsc.start(); this.buzzOsc.start();
  }

  // ── AIRFLOW (rush + buffet) ──
  _buildWind() {
    const ctx = this.ctx;
    const windHP = this._filter('highpass', 200, 0.7);
    this.windBP = this._filter('bandpass', 500, 0.5);
    this.windGain = this._gain(0);
    this._noiseSrc().connect(windHP).connect(this.windBP).connect(this.windGain).connect(this.busWind);
    const rushHP = this._filter('highpass', 2500, 0.7);
    this.rushGain = this._gain(0);
    this._noiseSrc().connect(rushHP).connect(this.rushGain).connect(this.busWind);
    const buffetLP = this._filter('lowpass', 120, 0.7);
    this.buffetGain = this._gain(0);
    this._noiseSrc().connect(buffetLP).connect(this.buffetGain).connect(this.busWind);
    const buffetLFO = ctx.createOscillator(); buffetLFO.type = 'sine'; buffetLFO.frequency.value = 14;
    this.buffetLfoGain = this._gain(0); buffetLFO.connect(this.buffetLfoGain).connect(this.buffetGain.gain); buffetLFO.start();
  }

  // ── STALL horn (two square waves beating, warbled) ──
  _buildStall() {
    const ctx = this.ctx;
    this.stallA = ctx.createOscillator(); this.stallA.type = 'square'; this.stallA.frequency.value = 400;
    this.stallB = ctx.createOscillator(); this.stallB.type = 'square'; this.stallB.frequency.value = 404;
    const bp = this._filter('bandpass', 1200, 3);
    this.stallGain = this._gain(0);
    this.stallA.connect(bp); this.stallB.connect(bp); bp.connect(this.stallGain).connect(this.busWarn);
    this.stallLFO = ctx.createOscillator(); this.stallLFO.type = 'sine'; this.stallLFO.frequency.value = 6;
    this.stallLFOg = this._gain(0); this.stallLFO.connect(this.stallLFOg).connect(this.stallGain.gain);
    this.stallA.start(); this.stallB.start(); this.stallLFO.start();
  }

  // ── GEAR motor whir ──
  _buildGear() {
    this.gearOsc = this.ctx.createOscillator(); this.gearOsc.type = 'sawtooth'; this.gearOsc.frequency.value = 220;
    this.gearLP = this._filter('lowpass', 1200, 0.7);
    this.gearGain = this._gain(0);
    this.gearOsc.connect(this.gearLP).connect(this.gearGain).connect(this.busMech);
    const nHP = this._filter('highpass', 800, 0.7);
    const nG = this._gain(0.15);
    this._noiseSrc().connect(nHP).connect(nG).connect(this.gearGain);
    this.gearOsc.start();
  }

  // ── FLAP motor whir ──
  _buildFlap() {
    this.flapOsc = this.ctx.createOscillator(); this.flapOsc.type = 'sawtooth'; this.flapOsc.frequency.value = 300;
    const lp = this._filter('lowpass', 1500, 0.7);
    this.flapGain = this._gain(0);
    this.flapOsc.connect(lp).connect(this.flapGain).connect(this.busMech);
    this.flapOsc.start();
  }

  // ── TIRE rumble + bump ──
  _buildRoll() {
    this.rollLP = this._filter('lowpass', 200, 0.7);
    this.rollGain = this._gain(0);
    this._noiseSrc().connect(this.rollLP).connect(this.rollGain).connect(this.busRoll);
    this.bumpLFO = this.ctx.createOscillator(); this.bumpLFO.type = 'sine'; this.bumpLFO.frequency.value = 2;
    this.bumpG = this._gain(0); this.bumpLFO.connect(this.bumpG).connect(this.rollGain.gain); this.bumpLFO.start();
  }

  // ── per-frame mapping ──
  update(fm, dt) {
    if (!this.started || !this.ctx) return;
    const t = this.ctx.currentTime, thr = fm.thrustFrac ?? fm.throttle ?? 0;
    const isPiston = fm.engineType ? fm.engineType === 'piston' : !!fm.ac.propVisual;

    // crossfade the two engine chains (no teardown → click-free aircraft swaps)
    this.pistonGain.gain.setTargetAtTime(isPiston ? 1 : 0, t, 0.12);
    this.turbineGain.gain.setTargetAtTime(isPiston ? 0 : 1, t, 0.2);

    if (isPiston) {
      const rpm = 700 + Math.pow(thr, 0.85) * 2000;
      const revHz = rpm / 60, f0 = 2 * revHz;
      this.propOsc.frequency.setTargetAtTime(f0, t, 0.08);
      this.amLFO.frequency.setTargetAtTime(revHz, t, 0.08);
      this.propLP.frequency.setTargetAtTime(600 + thr * 2200, t, 0.1);
      this.engPistonGain.gain.setTargetAtTime(0.05 + thr * 0.20, t, 0.1);
      this.exhaustGain.gain.setTargetAtTime(0.015 + thr * 0.02, t, 0.1);
    } else {
      const n1Hz = (1040 + thr * 4160) / 60, bpf = n1Hz * 24;
      this.whineOsc.frequency.setTargetAtTime(bpf, t, 0.15);
      this.buzzOsc.frequency.setTargetAtTime(n1Hz, t, 0.15);
      this.rumbleLP.frequency.setTargetAtTime(90 + thr * 140, t, 0.1);
      this.spoolBP.frequency.setTargetAtTime(350 + thr * 1600, t, 0.1);
      this.rumbleGain.gain.setTargetAtTime(0.06 + thr * 0.10, t, 0.1);
      this.spoolGain.gain.setTargetAtTime(0.05 + thr * 0.09, t, 0.1);
      this.whineGain.gain.setTargetAtTime((0.05 + (1 - thr) * 0.05) * 0.6, t, 0.1); // louder at low thrust
      this.buzzGain.gain.setTargetAtTime(Math.max(0, Math.min(1, (thr - 0.70) / 0.30)) * 0.06, t, 0.2);
    }

    // wind — fm.ias is m/s; q normalized (~194 kt ref). q² so taxi is silent.
    const q = Math.min(Math.max((fm.ias ?? fm.V ?? 0) / 100, 0), 1.6);
    this.windBP.frequency.setTargetAtTime(400 + q * 1200, t, 0.2);
    this.windGain.gain.setTargetAtTime(q * q * 0.10, t, 0.2);
    this.rushGain.gain.setTargetAtTime(Math.max(0, q - 0.7) * 0.05, t, 0.2);
    let buffet = q * 0.02 + (fm.surf?.flap || 0) * 0.02;
    if (fm.stalled) buffet += 0.06;
    if (fm.overspeed) buffet += 0.05;
    if (fm.gearPos > 0.02 && fm.gearPos < 0.98) buffet += 0.03;
    this.buffetGain.gain.setTargetAtTime(buffet, t, 0.15);
    this.buffetLfoGain.gain.setTargetAtTime(fm.stalled ? 0.04 : 0, t, 0.1);

    this._updateStall(fm, t, isPiston);
    this._updateOverspeed(fm, t);
    this._updateGear(fm, t);
    this._updateFlap(fm, t);
    this._updateTouchdown(fm, t);
    this._updateRoll(fm, t);
  }

  _updateStall(fm, t, isPiston) {
    const preStall = !fm.onGround && fm.V < fm.ac.stallSpeed * 1.05;
    const want = (fm.stalled || preStall) && isPiston;   // jets use a stick-shaker, not a reed horn
    const g = this.stallGain.gain;
    if (want && !this._stallOn) {
      this._stallOn = true;
      g.cancelScheduledValues(t); g.setValueAtTime(Math.max(g.value, 1e-4), t);
      g.linearRampToValueAtTime(0.18, t + 0.04);
      this.stallLFOg.gain.setTargetAtTime(0.10, t, 0.1);
    } else if (!want && this._stallOn) {
      this._stallOn = false;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(1e-4, t + 0.06);
      this.stallLFOg.gain.setTargetAtTime(0, t, 0.05);
    }
    if (this._stallOn) {
      this.stallA.frequency.setTargetAtTime(fm.stalled ? 420 : 400, t, 0.15);
      this.stallLFO.frequency.setTargetAtTime(fm.stalled ? 8 : 6, t, 0.15);
    }
  }

  _updateOverspeed(fm, t) {
    const over = fm.overspeed || fm.flapOverspeed || fm.gearOverspeed;
    if (over) {
      if (!this._clackOn) { this._clackOn = true; this._clackNext = t; }
      while (this._clackNext < t + 0.2) { this._clack(this._clackNext); this._clackNext += 0.15; }
    } else this._clackOn = false;
  }

  _updateGear(fm, t) {
    if (fm.fixedGear) { this._prevGear = fm.gearPos; return; }
    const moving = Math.abs(fm.gearPos - this._prevGear) > 1e-4 && fm.gearPos > 0 && fm.gearPos < 1;
    this.gearGain.gain.setTargetAtTime(moving ? 0.12 : 0, t, 0.05);
    this.gearOsc.frequency.setTargetAtTime(200 + fm.gearPos * 40, t, 0.1);
    if (this._prevGear < 1 && fm.gearPos >= 1) this._clunk(t, 0.45);
    if (this._prevGear > 0 && fm.gearPos <= 0) this._clunk(t, 0.50);
    this._prevGear = fm.gearPos;
  }

  _updateFlap(fm, t) {
    const f = fm.surf?.flap ?? 0;
    const moving = Math.abs(f - this._prevFlap) > 1e-4;
    this.flapGain.gain.setTargetAtTime(moving ? 0.08 : 0, t, 0.05);
    this._prevFlap = f;
  }

  _updateTouchdown(fm, t) {
    if (fm.justLanded && fm.lastTouchdown && fm.lastTouchdown !== this._lastTd) {
      this._lastTd = fm.lastTouchdown;
      this._thunk(t, fm.lastTouchdown.sinkMs || 0.5);
    }
  }

  _updateRoll(fm, t) {
    const rolling = fm.onGround && fm.groundSpeed > 1, gs = fm.groundSpeed;
    if (rolling) {
      const amt = Math.min(gs / 60, 1);
      this.rollGain.gain.setTargetAtTime(0.04 + amt * 0.16, t, 0.1);
      this.rollLP.frequency.setTargetAtTime(120 + amt * 380, t, 0.1);
      this.bumpLFO.frequency.setTargetAtTime(0.5 + gs * 0.15, t, 0.2);
      this.bumpG.gain.setTargetAtTime(0.03 + amt * 0.05, t, 0.2);
    } else {
      this.rollGain.gain.setTargetAtTime(0, t, 0.25);
      this.bumpG.gain.setTargetAtTime(0, t, 0.25);
    }
  }

  // ── one-shots (create → ramp → stop after decay; nodes self-GC) ──
  _clack(at) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    src.loop = true; const off = Math.random() * 1.5; // vary the slice
    const bp = this._filter('bandpass', 2200, 8);
    const ring = ctx.createOscillator(); ring.type = 'triangle'; ring.frequency.value = 2000;
    const g = this._gain(0.0001);
    src.connect(bp).connect(g); ring.connect(g); g.connect(this.busWarn);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.5, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
    src.start(at, off); ring.start(at); src.stop(at + 0.06); ring.stop(at + 0.06);
  }

  _clunk(at, lvl) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(150, at); o.frequency.exponentialRampToValueAtTime(60, at + 0.08);
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const lp = this._filter('lowpass', 400, 0.7);
    const g = this._gain(0.0001);
    o.connect(g); src.connect(lp).connect(g); g.connect(this.busMech);
    g.gain.setValueAtTime(lvl, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
    o.start(at); src.start(at, Math.random()); o.stop(at + 0.2); src.stop(at + 0.2);
  }

  _thunk(at, sink) {
    const ctx = this.ctx;
    const lvl = Math.min(0.15 + sink * 0.18, 0.7);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120 + sink * 20, at); o.frequency.exponentialRampToValueAtTime(45, at + 0.12);
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const bp = this._filter('bandpass', 600 + sink * 400, 1.2);
    const g = this._gain(0.0001);
    o.connect(g); src.connect(bp).connect(g); g.connect(this.busMech);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(lvl, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
    o.start(at); src.start(at, Math.random()); o.stop(at + 0.3); src.stop(at + 0.3);
  }

  // ── volume / mute ──
  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.started && this.master)
      this.master.gain.setTargetAtTime(this.enabled ? this._volume : 0, this.ctx.currentTime, 0.03);
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.started && this.master)
      this.master.gain.setTargetAtTime(on ? this._volume : 0, this.ctx.currentTime, 0.03);
  }
}
