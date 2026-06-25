// The visible aircraft: loads a glTF model and drives its position/orientation
// from the flight model every frame. Also exposes the ECEF transform the
// camera rig needs to follow it.
import * as Cesium from 'cesium';
import { DEG } from './util.js';

export class Aircraft {
  constructor(scene) {
    this.scene = scene;
    this.model = null;
    this.def = null;
    this.position = new Cesium.Cartesian3();
    this.frameMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY); // true flight frame (camera uses this)
    this.modelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY); // frame * axis-fix (geometry uses this)
    this.hpr = new Cesium.HeadingPitchRoll();
    this._loadToken = 0;
  }

  // Build the constant rotation that re-maps a model's local axes onto Cesium's
  // convention (nose → +X, up → +Z). Cesium sample models are already correct;
  // the Flightradar24 models use nose=+Y, up=+X, wings=+Z.
  _buildFix(axis) {
    if (axis === 'fr24') {
      // Determined empirically by top-down rendering: the exported models have
      // nose on -X and "up" (dorsal) on +Z. Re-map to Cesium's nose=+X, up=+Z:
      //   model nose(-X)→+X,  model up(+Z)→+Z  (a 180° turn about the up axis).
      const m3 = new Cesium.Matrix3(-1, 0, 0, 0, -1, 0, 0, 0, 1);
      return Cesium.Matrix4.fromRotationTranslation(m3, Cesium.Cartesian3.ZERO);
    }
    return null; // identity
  }

  async load(def) {
    this.def = def;
    this.fixMatrix = this._buildFix(def.axis);
    const token = ++this._loadToken;
    const model = await Cesium.Model.fromGltfAsync({
      url: def.model,
      scale: def.scale,
      minimumPixelSize: def.minimumPixelSize,
      maximumScale: 20000,
      shadows: Cesium.ShadowMode.DISABLED, // shadows are GPU-heavy and crash-prone under memory pressure
      // start hidden until first placement to avoid a one-frame flash at (0,0,0)
      show: false,
    });
    if (token !== this._loadToken) return; // a newer load superseded us
    if (this._lightPoints) { this.scene.primitives.remove(this._lightPoints); this._lightPoints = null; this._lights = null; }
    if (this.model) this.scene.primitives.remove(this.model);
    this.model = this.scene.primitives.add(model);
    this.ready = false;
    this._surfReady = false;
    this._surf = null;
  }

  // Capture the control-surface nodes + their rest transforms (once, after load).
  _captureSurfaces() {
    this._surfReady = true;
    this._surf = [];
    const cfg = this.def.surfaces;
    if (!cfg) return;
    for (const key in cfg) {
      const s = cfg[key];
      let node;
      try { node = this.model.getNode(s.node); } catch { node = null; }
      if (!node) continue;
      const orig = Cesium.Matrix4.clone(node.originalMatrix || node.matrix);
      // Rotate about the surface's true hinge: its geometric centre (pivot) on its
      // longest axis (the span/hinge line). This keeps it attached to the airframe.
      const piv = s.pivot ? new Cesium.Cartesian3(s.pivot[0], s.pivot[1], s.pivot[2]) : new Cesium.Cartesian3();
      const Tp = Cesium.Matrix4.fromTranslation(piv);
      const Tpn = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.negate(piv, new Cesium.Cartesian3()));
      this._surf.push({ node, orig, s, Tp, Tpn,
        m3: new Cesium.Matrix3(), a: new Cesium.Matrix4(), b: new Cesium.Matrix4(), c: new Cesium.Matrix4() });
    }
    // landing-gear nodes (shown when deployed, hidden when retracted)
    this._gearNodes = [];
    for (const name of (this.def.gearNodes || [])) {
      let n; try { n = this.model.getNode(name); } catch { n = null; }
      if (n) this._gearNodes.push(n);
    }
    this._gearShown = true;
    this._buildLights();

    // propeller: spin the solid blades at low RPM, swap to the translucent blur
    // disc at high RPM (where individual blades would strobe at 60 fps).
    this._prop = null;
    if (this.def.propVisual) {
      const get = (n) => { try { return this.model.getNode(n); } catch { return null; } };
      const helice = get('helice');
      if (helice) {
        const blur = get('propblur'), disc = get('propdisc');
        if (blur) blur.show = false;          // start on the solid (slow) blades
        if (disc) disc.show = false;
        this._prop = {
          helice, blur, disc, angle: 0, fast: undefined,
          orig: Cesium.Matrix4.clone(helice.originalMatrix || helice.matrix),
          m3: new Cesium.Matrix3(), r: new Cesium.Matrix4(), out: new Cesium.Matrix4(),
        };
      }
    }
  }

  // Spin the propeller about its hub (mesh-local X = the model's longitudinal axis),
  // at a rate set by engine power, and cut to the blur disc once it's spinning fast.
  _animateProp(dt, state) {
    const p = this._prop;
    if (!p) return;
    const rpm = 0.18 + 0.82 * (state.thrustFrac ?? state.throttle ?? 0); // idle ⇒ full
    p.angle = (p.angle + rpm * 140 * dt) % (Math.PI * 2);
    Cesium.Matrix3.fromRotationX(p.angle, p.m3);
    Cesium.Matrix4.fromRotationTranslation(p.m3, Cesium.Cartesian3.ZERO, p.r);
    p.helice.matrix = Cesium.Matrix4.multiply(p.orig, p.r, p.out); // rest · spin
    const fast = rpm > 0.5;
    if (fast !== p.fast) {
      p.fast = fast;
      p.helice.show = !fast;
      if (p.blur) p.blur.show = fast;
      if (p.disc) p.disc.show = fast;
    }
  }

  // ── exterior lights: nav (steady R/G/W), beacon (red flash), strobes (white
  // double-pulse), landing light. One PointPrimitiveCollection, glow faked with a
  // translucent halo point (no bloom — too costly on a fragile GPU). ──
  _buildLights() {
    if (this._lightPoints) { this.scene.primitives.remove(this._lightPoints); this._lightPoints = null; }
    const span = this.def.span || 11, half = span / 2;
    const nose = 0.42 * span, tail = -0.55 * span;
    const C = Cesium.Color;
    this._lightPoints = this.scene.primitives.add(new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }));
    this._lt = 0; this.landingLightOn = false;
    const add = (off, color, size, halo) => {
      const mk = (sz, alpha) => this._lightPoints.add({
        position: new Cesium.Cartesian3(), color: alpha != null ? color.withAlpha(alpha) : color,
        pixelSize: sz, show: false, disableDepthTestDistance: 50.0,
        scaleByDistance: new Cesium.NearFarScalar(60, 1.0, 9000, 0.4),
        translucencyByDistance: new Cesium.NearFarScalar(9000, 1.0, 45000, 0.0),
      });
      return { core: mk(size), halo: halo ? mk(size * 2.4, 0.22) : null, off };
    };
    this._lights = {
      navRed:   add([0.0, -half, 0.0], C.fromCssColorString('#FF1A1A'), 11, true),  // left wingtip
      navGreen: add([0.0,  half, 0.0], C.fromCssColorString('#33FF33'), 11, true),  // right wingtip
      navWhite: add([tail, 0.0,  0.3], C.WHITE, 9, true),                            // tail
      beacon:   add([0.0,  0.0,  1.0], C.fromCssColorString('#FF2200'), 16, true),   // anti-collision
      strobeL:  add([0.0, -half, 0.0], C.WHITE, 15, true),
      strobeR:  add([0.0,  half, 0.0], C.WHITE, 15, true),
      landing:  add([nose * 0.4, -half * 0.45, -0.25], C.WHITE, 20, true),           // fwd
    };
  }

  updateLights(dt, isNight, state) {
    if (!this._lights) return;
    for (const k in this._lights) {
      const L = this._lights[k];
      this.bodyPointToWorld(L.off[0], L.off[1], L.off[2], L.core.position);
      if (L.halo) Cesium.Cartesian3.clone(L.core.position, L.halo.position);
    }
    const t = (this._lt += dt);
    const set = (L, on) => { L.core.show = on; if (L.halo) L.halo.show = on; };
    const airborne = !state.onGround, lowAlt = state.agl < 3048;
    const onRwy = state.onRunwayActive;
    const navOn = isNight, beaconOn = isNight;
    const strobeOn = isNight && (airborne || onRwy);
    const landingOn = isNight && (airborne ? lowAlt : onRwy);
    set(this._lights.navRed, navOn); set(this._lights.navGreen, navOn); set(this._lights.navWhite, navOn);
    set(this._lights.beacon, beaconOn && ((t % 1.333) < 0.12));          // ~45/min
    const sp = t % 1.0, strobe = strobeOn && (sp < 0.045 || (sp >= 0.11 && sp < 0.155)); // double-pulse
    set(this._lights.strobeL, strobe); set(this._lights.strobeR, strobe);
    set(this._lights.landing, landingOn);
  }

  // Deflect each surface: node.matrix = rest · T(pivot) · R(hingeAxis, angle) · T(-pivot).
  _animateSurfaces(state) {
    if (!this._surf || !state.surf) return;
    const d = state.surf;
    for (const it of this._surf) {
      const drv = it.s.driver;
      const val = drv === 'roll' ? d.aileron : drv === 'pitch' ? d.elevator
                : drv === 'yaw' ? d.rudder : drv === 'flaps' ? d.flap : 0;
      const angle = val * it.s.max * DEG * it.s.sign;
      if (it.s.axis === 'x') Cesium.Matrix3.fromRotationX(angle, it.m3);
      else if (it.s.axis === 'z') Cesium.Matrix3.fromRotationZ(angle, it.m3);
      else Cesium.Matrix3.fromRotationY(angle, it.m3);
      Cesium.Matrix4.fromRotationTranslation(it.m3, Cesium.Cartesian3.ZERO, it.a); // R
      Cesium.Matrix4.multiply(it.Tp, it.a, it.b);    // T(p)·R
      Cesium.Matrix4.multiply(it.b, it.Tpn, it.b);   // T(p)·R·T(-p)   (pivot is in PARENT space)
      it.node.matrix = Cesium.Matrix4.multiply(it.b, it.orig, it.c);  // rotate the rest pose about the hinge
    }
    // gear: show once it's more than half deployed
    if (this._gearNodes && this._gearNodes.length) {
      const show = (state.gearPos ?? 1) > 0.5;
      if (show !== this._gearShown) {
        this._gearShown = show;
        for (const n of this._gearNodes) n.show = show;
      }
    }
  }

  // state: FlightModel instance
  update(state, dt = 1 / 60, isNight = false) {
    if (!this.model) return;
    const { lon, lat } = state;             // radians
    const height = state.height;
    Cesium.Cartesian3.fromRadians(lon, lat, height, Cesium.Ellipsoid.WGS84, this.position);

    // Cesium's headingPitchRollToFixedFrame aligns the frame's forward (+X) axis
    // to bearing (heading + 90°) because the underlying ENU frame's X is East.
    // Our flight model's velocity points along `heading` directly, so subtract 90°
    // to make the model nose AND the camera follow the actual direction of travel.
    this.hpr.heading = state.heading - Math.PI / 2;
    this.hpr.pitch = state.pitch;
    this.hpr.roll = state.roll;

    Cesium.Transforms.headingPitchRollToFixedFrame(
      this.position, this.hpr, Cesium.Ellipsoid.WGS84,
      Cesium.Transforms.eastNorthUpToFixedFrame, this.frameMatrix
    );
    if (this.fixMatrix) {
      Cesium.Matrix4.multiply(this.frameMatrix, this.fixMatrix, this.modelMatrix);
    } else {
      Cesium.Matrix4.clone(this.frameMatrix, this.modelMatrix);
    }

    if (this.model.ready) {
      this.model.modelMatrix = this.modelMatrix;
      if (!this.model.show) this.model.show = true;
      this.ready = true;
      if (!this._surfReady) this._captureSurfaces();
      this._animateSurfaces(state);
      this._animateProp(dt, state);
      this.updateLights(dt, isNight, state);
    }
  }

  // Body-frame offset (forward/right/up, meters) → world ECEF point, using the
  // true flight frame (X fwd, Y left, Z up) regardless of the model's own axes.
  bodyPointToWorld(forward, right, up, result) {
    const local = new Cesium.Cartesian3(forward, -right, up);
    return Cesium.Matrix4.multiplyByPoint(this.frameMatrix, local, result || new Cesium.Cartesian3());
  }

  setVisible(v) { if (this.model) this.model.show = v; }
}
