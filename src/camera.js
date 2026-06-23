// Camera rig: follows the aircraft in several modes (chase / cockpit / orbit / flyby).
import * as Cesium from 'cesium';
import { damp } from './util.js';

const MODES = ['chase', 'cockpit', 'orbit', 'flyby'];

export class CameraRig {
  constructor(viewer) {
    this.viewer = viewer;
    this.camera = viewer.camera;
    this.modeIndex = 0;
    this.smoothEye = null;
    this.orbitAngle = 0;
    this.flybyAnchor = null;

    // scratch
    this._fwd = new Cesium.Cartesian3();
    this._right = new Cesium.Cartesian3();
    this._up = new Cesium.Cartesian3();
    this._eye = new Cesium.Cartesian3();
    this._dir = new Cesium.Cartesian3();
    this._tmp = new Cesium.Cartesian3();
  }

  get mode() { return MODES[this.modeIndex]; }
  get modeLabel() { return this.mode.toUpperCase(); }
  cycle() { this.modeIndex = (this.modeIndex + 1) % MODES.length; this.smoothEye = null; this.flybyAnchor = null; }
  setMode(m) { const i = MODES.indexOf(m); if (i >= 0) { this.modeIndex = i; this.smoothEye = null; } }

  _axes(aircraft) {
    const m = aircraft.frameMatrix; // true flight frame: col0 fwd, col1 left, col2 up
    Cesium.Matrix4.getColumn(m, 0, this._fwd);   Cesium.Cartesian3.normalize(this._fwd, this._fwd);
    Cesium.Matrix4.getColumn(m, 1, this._right); Cesium.Cartesian3.normalize(this._right, this._right);
    Cesium.Matrix4.getColumn(m, 2, this._up);    Cesium.Cartesian3.normalize(this._up, this._up);
  }

  update(dt, aircraft, state) {
    if (!aircraft.model) return;
    this._axes(aircraft);
    const pos = aircraft.position;
    const geoUp = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new Cesium.Cartesian3());
    const def = aircraft.def;

    if (this.mode === 'cockpit') {
      // eye just behind the nose, looking forward along the fuselage
      aircraft.bodyPointToWorld(def.cockpit.forward, 0, def.cockpit.up, this._eye);
      Cesium.Cartesian3.clone(this._fwd, this._dir);
      this._setView(this._eye, this._dir, this._up);
      return;
    }

    if (this.mode === 'orbit') {
      this.orbitAngle += dt * 0.25;
      const r = def.chase.back * 1.6 + 12;
      const east = Cesium.Cartesian3.cross(geoUp, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(east, east);
      const north = Cesium.Cartesian3.cross(east, geoUp, new Cesium.Cartesian3());
      const ca = Math.cos(this.orbitAngle), sa = Math.sin(this.orbitAngle);
      Cesium.Cartesian3.clone(pos, this._eye);
      Cesium.Cartesian3.add(this._eye, Cesium.Cartesian3.multiplyByScalar(east, r * ca, this._tmp), this._eye);
      Cesium.Cartesian3.add(this._eye, Cesium.Cartesian3.multiplyByScalar(north, r * sa, this._tmp), this._eye);
      Cesium.Cartesian3.add(this._eye, Cesium.Cartesian3.multiplyByScalar(geoUp, r * 0.45, this._tmp), this._eye);
      Cesium.Cartesian3.subtract(pos, this._eye, this._dir);
      Cesium.Cartesian3.normalize(this._dir, this._dir);
      this._setView(this._eye, this._dir, geoUp);
      return;
    }

    if (this.mode === 'flyby') {
      const dist = this.flybyAnchor ? Cesium.Cartesian3.distance(this.flybyAnchor, pos) : Infinity;
      if (!this.flybyAnchor || dist > 1600 || dist < 60) {
        // plant a fresh vantage point ahead-and-to-the-side of the aircraft
        this.flybyAnchor = new Cesium.Cartesian3();
        Cesium.Cartesian3.clone(pos, this.flybyAnchor);
        Cesium.Cartesian3.add(this.flybyAnchor, Cesium.Cartesian3.multiplyByScalar(this._fwd, 600, this._tmp), this.flybyAnchor);
        Cesium.Cartesian3.add(this.flybyAnchor, Cesium.Cartesian3.multiplyByScalar(this._right, 220, this._tmp), this.flybyAnchor);
        Cesium.Cartesian3.add(this.flybyAnchor, Cesium.Cartesian3.multiplyByScalar(geoUp, 40, this._tmp), this.flybyAnchor);
      }
      Cesium.Cartesian3.subtract(pos, this.flybyAnchor, this._dir);
      Cesium.Cartesian3.normalize(this._dir, this._dir);
      this._setView(this.flybyAnchor, this._dir, geoUp);
      return;
    }

    // ---- chase (default): behind & above, smoothed for a trailing feel ----
    Cesium.Cartesian3.clone(pos, this._eye);
    Cesium.Cartesian3.add(this._eye, Cesium.Cartesian3.multiplyByScalar(this._fwd, -def.chase.back, this._tmp), this._eye);
    Cesium.Cartesian3.add(this._eye, Cesium.Cartesian3.multiplyByScalar(geoUp, def.chase.up, this._tmp), this._eye);

    if (!this.smoothEye) this.smoothEye = Cesium.Cartesian3.clone(this._eye, new Cesium.Cartesian3());
    const k = 6;
    this.smoothEye.x = damp(this.smoothEye.x, this._eye.x, k, dt);
    this.smoothEye.y = damp(this.smoothEye.y, this._eye.y, k, dt);
    this.smoothEye.z = damp(this.smoothEye.z, this._eye.z, k, dt);

    // look slightly ahead of the aircraft
    Cesium.Cartesian3.add(pos, Cesium.Cartesian3.multiplyByScalar(this._fwd, def.chase.back * 0.4, this._tmp), this._dir);
    Cesium.Cartesian3.subtract(this._dir, this.smoothEye, this._dir);
    Cesium.Cartesian3.normalize(this._dir, this._dir);
    this._setView(this.smoothEye, this._dir, geoUp);
  }

  _setView(eye, dir, up) {
    this.camera.setView({
      destination: eye,
      orientation: { direction: dir, up: up },
    });
  }
}
