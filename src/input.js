// Keyboard + gamepad/joystick input. Produces smoothed analog control axes
// (pitch/roll/yaw, each -1..1) and fires discrete action callbacks.
import { clamp, damp } from './util.js';

const DEADZONE = 0.12;
const dz = (v) => (Math.abs(v) < DEADZONE ? 0 : v);

export class Input {
  constructor(actions) {
    this.actions = actions;          // { onGear, onFlaps(+1/-1), onParking, onTrim(d),
                                     //   onThrottleSet(v), onCamera, onAutopilot, onPanel,
                                     //   onReset, onMenu, onHelp, onBrake(bool) }
    this.keys = new Set();
    this.cur = { pitch: 0, roll: 0, yaw: 0 };
    this.sensitivity = 1;
    this.invertY = false;
    this.throttleDelta = 0;          // accumulated each frame, applied by main
    this.padIndex = null;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('gamepadconnected', (e) => {
      this.padIndex = e.gamepad.index;
      this._padOffsets = null;     // captured on first poll (resting = center)
      this._padEngaged = false;    // ignore axes until the user clearly moves them
    });
    window.addEventListener('gamepaddisconnected', () => { this.padIndex = null; });
    this._padPrev = {};
  }

  _typingInField(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  _onKeyDown(e) {
    if (this._typingInField(e)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // prevent page scroll on the flight keys
    if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
    if (this.keys.has(k)) return;    // ignore auto-repeat for discrete actions
    this.keys.add(k);

    const a = this.actions;
    switch (k) {
      case 'g': a.onGear?.(); break;
      case 'f': a.onFlaps?.(+1); break;
      case 'v': a.onFlaps?.(-1); break;
      case ' ': a.onParking?.(); break;
      case 'z': a.onThrottleSet?.(0); break;
      case 'x': a.onThrottleSet?.(1); break;
      case 'c': a.onCamera?.(); break;
      case 't': a.onAutopilot?.(); break;
      case 'p': a.onPanel?.(); break;
      case 'r': a.onReset?.(); break;
      case 'Escape': a.onMenu?.(); break;
      case 'h': a.onHelp?.(); break;
      case 'b': a.onBrake?.(true); break;
    }
  }

  _onKeyUp(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    this.keys.delete(k);
    if (k === 'b') this.actions.onBrake?.(false);
  }

  _has(...ks) { return ks.some(k => this.keys.has(k)); }

  // Called every frame. dt seconds.
  update(dt) {
    // ---- keyboard analog targets ----
    let tRoll = 0, tPitch = 0, tYaw = 0;
    if (this._has('a', 'ArrowLeft')) tRoll -= 1;
    if (this._has('d', 'ArrowRight')) tRoll += 1;
    if (this._has('w', 'ArrowUp')) tPitch -= 1;     // push: nose down
    if (this._has('s', 'ArrowDown')) tPitch += 1;   // pull: nose up
    if (this._has('q')) tYaw -= 1;
    if (this._has('e')) tYaw += 1;

    this.throttleDelta = 0;
    if (this._has('Shift')) this.throttleDelta += 0.45 * dt;
    if (this._has('Control')) this.throttleDelta -= 0.45 * dt;
    if (this._has('[')) this.actions.onTrim?.(-0.25 * dt);
    if (this._has(']')) this.actions.onTrim?.(+0.25 * dt);

    // ---- gamepad ----
    const pad = this._poll();
    if (pad) {
      // calibrate the resting position once, then subtract it (kills stick drift)
      if (!this._padOffsets) this._padOffsets = (pad.axes || []).slice(0, 4);
      const ax = (i) => (pad.axes[i] ?? 0) - (this._padOffsets[i] ?? 0);
      // only start reading axes once the user deliberately moves a stick or
      // presses a button — a quietly-connected, drifting controller stays inert
      if (!this._padEngaged) {
        const moved = [0, 1, 2, 3].some((i) => Math.abs(ax(i)) > 0.4);
        const pressed = pad.buttons.some((b) => b.pressed);
        if (moved || pressed) this._padEngaged = true;
      }
      if (this._padEngaged) {
        tRoll = clamp(tRoll + dz(ax(0)), -1, 1);
        tPitch = clamp(tPitch + dz(ax(1)), -1, 1);
        tYaw = clamp(tYaw + dz(ax(2)), -1, 1);
        const rt = pad.buttons[7]?.value ?? 0;
        const lt = pad.buttons[6]?.value ?? 0;
        this.throttleDelta += (rt - lt) * 0.6 * dt;
        this._padButtons(pad);
      }
    }

    if (this.invertY) tPitch = -tPitch;

    // ---- smooth toward targets (sensitivity = snappiness) ----
    const rate = 7 * this.sensitivity;
    this.cur.roll = damp(this.cur.roll, clamp(tRoll, -1, 1), rate, dt);
    this.cur.pitch = damp(this.cur.pitch, clamp(tPitch, -1, 1), rate, dt);
    this.cur.yaw = damp(this.cur.yaw, clamp(tYaw, -1, 1), rate, dt);
  }

  _poll() {
    if (this.padIndex === null || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    return pads[this.padIndex] || null;
  }

  _edge(pad, i) {
    const pressed = !!pad.buttons[i]?.pressed;
    const was = this._padPrev[i];
    this._padPrev[i] = pressed;
    return pressed && !was;
  }

  _padButtons(pad) {
    const a = this.actions;
    if (this._edge(pad, 0)) a.onGear?.();        // A
    if (this._edge(pad, 1)) a.onFlaps?.(+1);     // B
    if (this._edge(pad, 2)) a.onFlaps?.(-1);     // X
    if (this._edge(pad, 3)) a.onCamera?.();      // Y
    if (this._edge(pad, 8)) a.onParking?.();     // Back/Select
    if (this._edge(pad, 9)) a.onMenu?.();        // Start
    const brake = !!pad.buttons[5]?.pressed;     // RB hold = brake
    if (brake !== this._padPrev.brake) { a.onBrake?.(brake); this._padPrev.brake = brake; }
  }

  getControls() { return this.cur; }
  padConnected() { return this.padIndex !== null; }
}
