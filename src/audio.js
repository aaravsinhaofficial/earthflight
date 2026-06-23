// Procedural engine + wind audio (Web Audio API). Lazily started on first user
// gesture (browsers block autoplay otherwise).
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.started = false;
  }

  start() {
    if (this.started || !this.enabled) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      const ctx = this.ctx;

      // --- engine: sawtooth through a lowpass, pitch follows RPM ---
      this.osc = ctx.createOscillator();
      this.osc.type = 'sawtooth';
      this.osc.frequency.value = 60;
      this.engineLP = ctx.createBiquadFilter();
      this.engineLP.type = 'lowpass';
      this.engineLP.frequency.value = 700;
      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0;
      this.osc.connect(this.engineLP).connect(this.engineGain).connect(ctx.destination);
      this.osc.start();

      // --- wind: white noise through a bandpass, follows airspeed ---
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = ctx.createBufferSource();
      this.noise.buffer = buf; this.noise.loop = true;
      this.windBP = ctx.createBiquadFilter();
      this.windBP.type = 'bandpass'; this.windBP.frequency.value = 500; this.windBP.Q.value = 0.6;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      this.noise.connect(this.windBP).connect(this.windGain).connect(ctx.destination);
      this.noise.start();

      this.started = true;
    } catch (e) {
      console.warn('Audio unavailable', e);
      this.enabled = false;
    }
  }

  update(fm) {
    if (!this.started || !this.ctx) return;
    const t = this.ctx.currentTime;
    const base = fm.ac.propVisual ? 70 : 110;
    const freq = base + fm.throttle * (fm.ac.propVisual ? 130 : 240);
    this.osc.frequency.setTargetAtTime(freq, t, 0.08);
    this.engineLP.frequency.setTargetAtTime(500 + fm.throttle * 2500, t, 0.1);
    this.engineGain.gain.setTargetAtTime(0.02 + fm.throttle * 0.10, t, 0.1);

    const windAmt = Math.min(fm.V / 120, 1);
    this.windBP.frequency.setTargetAtTime(300 + windAmt * 1400, t, 0.2);
    this.windGain.gain.setTargetAtTime(windAmt * 0.06, t, 0.2);
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.started) {
      this.engineGain.gain.value = on ? this.engineGain.gain.value : 0;
      this.windGain.gain.value = on ? this.windGain.gain.value : 0;
    }
  }
}
