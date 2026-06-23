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
      // After assimp's baked root transform, the exported models are
      // X=up, Y=wing, Z=aft (nose at -Z). Re-map to Cesium's nose=+X, up=+Z:
      //   model nose(-Z)→Cesium +X,  model up(+X)→Cesium +Z,  model +Y(wing)→+Y
      const m3 = new Cesium.Matrix3(0, 0, -1, 0, 1, 0, 1, 0, 0);
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
      shadows: Cesium.ShadowMode.ENABLED,
      // start hidden until first placement to avoid a one-frame flash at (0,0,0)
      show: false,
    });
    if (token !== this._loadToken) return; // a newer load superseded us
    if (this.model) this.scene.primitives.remove(this.model);
    this.model = this.scene.primitives.add(model);
    this.ready = false;
  }

  // state: FlightModel instance
  update(state) {
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
