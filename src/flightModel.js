// 6-DOF flight dynamics — the approach real sims (JSBSim/FlightGear, X-Plane) use:
// a rigid body with full FORCE and MOMENT equations built from aerodynamic
// stability & control derivatives. Attitude is a quaternion (no gimbal lock);
// angular rates p,q,r evolve from aerodynamic moments through the inertia tensor.
// This produces emergent realism: phugoid, Dutch roll, adverse yaw, spiral
// stability, proper stall/departure, and control-surface authority that scales
// with dynamic pressure.
//
// Ground handling stays a robust constrained sub-model (level on the gear, steer,
// brake, rotate) so taxi/takeoff/landing can't go numerically unstable.

import { clamp, damp, wrapPi, wrap360, airDensity, DEG } from './util.js';

const G = 9.80665;
const R_EARTH = 6378137;
const RHO0 = 1.225;

// Shared dimensionless stability & control derivatives for a conventional
// aircraft (per radian / per normalized control). Per-aircraft geometry, mass and
// inertia (from config) do the differentiating.
// Control terms (Cmde/Clda/Cndr/...) are effectiveness at FULL stick (the actual
// surface deflection is already normalized to -1..1 in this.surf), so they're
// modest. Rate derivatives use the nondimensional p̂,q̂,r̂. Damping is deliberately
// strong and static stability negative-Cmα / positive-Cnβ so the jet is steady.
const D = {
  CLq: 4.0,                      // pitch-rate lift
  CYbeta: -0.31, CYdr: 0.10,     // side force
  Clbeta: -0.12, Clp: -0.55, Clr: 0.09, Clda: 0.055, Cldr: 0.004, // roll moment (Clbeta = dihedral, spiral stability)
  Cm0: 0.0, Cmalpha: -0.7, Cmq: -24, Cmde: 0.20, Cmflap: -0.05,   // pitch moment (Cmde lets full stick reach stall)
  Cnbeta: 0.11, Cnp: -0.04, Cnr: -0.26, Cnda: -0.008, Cndr: 0.045,// yaw moment (Cnda<0 = adverse yaw)
};

// ── minimal quaternion helpers (q = [w,x,y,z], rotates BODY → NED) ──
const qMul = (a, b) => [
  a[0]*b[0] - a[1]*b[1] - a[2]*b[2] - a[3]*b[3],
  a[0]*b[1] + a[1]*b[0] + a[2]*b[3] - a[3]*b[2],
  a[0]*b[2] - a[1]*b[3] + a[2]*b[0] + a[3]*b[1],
  a[0]*b[3] + a[1]*b[2] - a[2]*b[1] + a[3]*b[0],
];
const qNorm = (q) => { const m = Math.hypot(q[0],q[1],q[2],q[3]) || 1; return [q[0]/m,q[1]/m,q[2]/m,q[3]/m]; };
function qFromEuler(psi, theta, phi) {            // body→NED, 3-2-1 (yaw-pitch-roll)
  const cz=Math.cos(psi/2), sz=Math.sin(psi/2);
  const cy=Math.cos(theta/2), sy=Math.sin(theta/2);
  const cx=Math.cos(phi/2), sx=Math.sin(phi/2);
  const qz=[cz,0,0,sz], qy=[cy,0,sy,0], qx=[cx,sx,0,0];
  return qMul(qMul(qz, qy), qx);                 // R_b2n = Rz(ψ)·Ry(θ)·Rx(φ)
}
function matFromQ(q) {                            // 3x3 rows; columns are body axes in NED
  const [w,x,y,z]=q;
  return [
    [1-2*(y*y+z*z), 2*(x*y-w*z),   2*(x*z+w*y)],
    [2*(x*y+w*z),   1-2*(x*x+z*z), 2*(y*z-w*x)],
    [2*(x*z-w*y),   2*(y*z+w*x),   1-2*(x*x+y*y)],
  ];
}
const matVec = (R,v) => [R[0][0]*v[0]+R[0][1]*v[1]+R[0][2]*v[2], R[1][0]*v[0]+R[1][1]*v[1]+R[1][2]*v[2], R[2][0]*v[0]+R[2][1]*v[1]+R[2][2]*v[2]];
const matTVec = (R,v) => [R[0][0]*v[0]+R[1][0]*v[1]+R[2][0]*v[2], R[0][1]*v[0]+R[1][1]*v[1]+R[2][1]*v[2], R[0][2]*v[0]+R[1][2]*v[1]+R[2][2]*v[2]];

export class FlightModel {
  constructor(aircraft) {
    this.setAircraft(aircraft);
    this.reset({ lon: 0, lat: 0, height: 0, heading: 0 });
  }

  setAircraft(ac) {
    this.ac = ac;
    this.S = ac.wingArea;
    this.b = ac.span || Math.sqrt((ac.wingArea) * 8);
    this.c = this.S / this.b;                 // mean chord
    this.AR = (this.b * this.b) / this.S;     // aspect ratio
    this.I = [ac.Ixx || ac.mass * 2, ac.Iyy || ac.mass * 3, ac.Izz || ac.mass * 4];
    this.alphaStall = (ac.clMax - ac.cl0) / ac.clAlpha;
    this.vRotate = ac.stallSpeed * 1.12;
  }

  reset({ lon, lat, height, heading, airborne }) {
    this.lon = lon * DEG; this.lat = lat * DEG; this.height = height;
    const psi = heading * DEG, theta = airborne ? 0 : 2 * DEG, phi = 0;
    this.q = qFromEuler(psi, theta, phi);
    this.p = 0; this.q_rate = 0; this.r = 0;            // body angular rates
    // spawn airborne at the (neutral-elevator) level-flight speed for this altitude,
    // so the aircraft starts trimmed and doesn't kick off a big phugoid.
    let V0 = 0;
    if (airborne) {
      const trimV = Math.sqrt(2 * this.ac.mass * G / (airDensity(height) * this.S * this.ac.cl0));
      V0 = clamp(trimV, this.ac.stallSpeed * 1.4, this.ac.vne * 0.85);
    }
    this.uvw = [V0, 0, 0];                              // body velocity
    this.trim = 0;
    this.throttle = airborne ? 0.6 : 0;
    this.flaps = 0; this.gearDown = true; this.gearPos = 1; // 0=up, 1=down (animated)
    this.parkingBrake = !airborne; this.wheelBrake = false; this.autopilotLevel = false;
    this.surf = { elevator: 0, aileron: 0, rudder: 0, flap: 0 };  // actual deflections (-1..1)
    this.onGround = !airborne;
    this.terrainHeight = airborne ? height - 500 : height - this.ac.wheelHeight;
    this.V = V0; this.alpha = theta; this.beta = 0;
    this.verticalSpeed = 0; this.groundSpeed = V0;
    this.loadFactor = 1; this.stalled = false; this.crashed = false;
    this._euler = { psi, theta, phi };
  }

  update(dt, controls, env) {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.05);
    const ac = this.ac, S = this.S, b = this.b, c = this.c;
    this.terrainHeight = env.terrainHeight;
    const groundH = this.terrainHeight + ac.wheelHeight;
    const weight = ac.mass * G;
    const rho = airDensity(this.height);

    // ── control-surface dynamics (rate-limited servo travel; drives visuals) ──
    const elevCmd = clamp((controls.pitch + this.trim), -1, 1);
    const ailCmd = clamp(controls.roll, -1, 1);
    const rudCmd = clamp(controls.yaw, -1, 1);
    const srate = 4.0; // ~0.25s full travel
    this.surf.elevator = damp(this.surf.elevator, elevCmd, srate, dt);
    this.surf.aileron = damp(this.surf.aileron, ailCmd, srate, dt);
    this.surf.rudder = damp(this.surf.rudder, rudCmd, srate, dt);
    this.surf.flap = damp(this.surf.flap, this.flaps, 1.2, dt);
    this.gearPos = damp(this.gearPos, this.gearDown ? 1 : 0, 0.7, dt); // ~3.5s gear cycle

    // ── current airspeed / flow angles ──
    let [u, v, w] = this.uvw;
    let V = Math.hypot(u, v, w);
    const Vsafe = Math.max(V, 1e-3);
    this.alpha = Math.atan2(w, Math.max(u, 0.1));
    this.beta = Math.asin(clamp(v / Vsafe, -1, 1));
    const qbar = 0.5 * rho * V * V;
    const thrust = this.throttle * ac.maxThrust * (rho / RHO0);

    // ── lift coefficient with smooth stall ──
    let CL = ac.cl0 + ac.clAlpha * this.alpha + ac.flapClBonus * this.surf.flap;
    this.stalled = !this.onGround && Math.abs(this.alpha) > this.alphaStall;
    if (Math.abs(this.alpha) > this.alphaStall) {
      const over = Math.abs(this.alpha) - this.alphaStall;
      const decay = Math.max(0.35, 1 - over * 2.5);
      CL = Math.sign(this.alpha) * (ac.cl0 + ac.clAlpha * this.alphaStall) * decay;
    }
    CL += D.CLq * (this.q_rate * c / (2 * Vsafe));
    const CD = ac.cd0 + (CL * CL) / (Math.PI * 0.8 * this.AR)
             + ac.flapDrag * this.surf.flap + ac.gearDrag * this.gearPos
             + (this.stalled ? 0.06 : 0);
    const CY = D.CYbeta * this.beta + D.CYdr * (D.Cndr > 0 ? this.surf.rudder : 0);

    const lift = qbar * S * CL;
    const drag = qbar * S * CD;
    this.loadFactor = lift / weight;

    if (this.onGround && lift < weight * 1.03) {
      // ───────────────── GROUND: constrained, always stable ─────────────────
      this.height = groundH;
      let e = this._euler;
      const rollResist = 0.025 + (this.wheelBrake ? 0.4 : 0) + (this.parkingBrake ? 0.9 : 0);
      const along = thrust - drag - Math.sign(V) * rollResist * weight;
      V = Math.max(0, V + (along / ac.mass) * dt);
      if ((this.parkingBrake || this.wheelBrake) && V < 0.3) V = 0;
      // nosewheel/rudder steering scales with speed
      const steer = rudCmd * 0.5 * clamp(V / 10, 0, 1.4);
      e.psi = wrapPi(e.psi + steer * dt);
      // sit level; raise the nose as you pull through rotation speed
      const wantPitch = (V > this.vRotate * 0.55 && controls.pitch > 0.1) ? clamp(controls.pitch, 0, 1) * 12 * DEG : 1.5 * DEG;
      e.theta = damp(e.theta, wantPitch, 6, dt);
      e.phi = damp(e.phi, 0, 8, dt);
      this.q = qFromEuler(e.psi, e.theta, e.phi);
      this.p = 0; this.q_rate = 0; this.r = 0;
      this.uvw = [V, 0, 0];
      this.verticalSpeed = 0; this.groundSpeed = V; this.V = V;
      this.alpha = e.theta;
      // Lift the wing actually makes at this attitude. On the ground the plane
      // rolls horizontally so the velocity-derived AoA is ~0 — use the pitch
      // attitude as the angle of attack instead, or it could never rotate.
      const clG = Math.min(ac.cl0 + ac.clAlpha * e.theta + ac.flapClBonus * this.surf.flap, ac.clMax);
      const liftG = qbar * ac.wingArea * clG;
      if (V > this.vRotate && liftG >= weight) {
        this.onGround = false;
        this.height = groundH + 0.5;                              // clear the wheels
        this.uvw = [V * Math.cos(e.theta), 0, V * Math.sin(e.theta)]; // AoA = pitch attitude
      }
      this._integratePosition(dt);
      return;
    }

    this.onGround = false;

    // ───────────────── AIRBORNE: full 6-DOF ─────────────────
    const R = matFromQ(this.q);                 // body→NED
    const gBody = matTVec(R, [0, 0, G]);        // gravity in body axes (NED down = +g)

    // aerodynamic force in body axes (wind→body via alpha; thrust along +x)
    const Fx = qbar * S * (CL * Math.sin(this.alpha) - CD * Math.cos(this.alpha)) + thrust;
    const Fy = qbar * S * CY;
    const Fz = qbar * S * (-CL * Math.cos(this.alpha) - CD * Math.sin(this.alpha));
    const ax = Fx / ac.mass + gBody[0];
    const ay = Fy / ac.mass + gBody[1];
    const az = Fz / ac.mass + gBody[2];

    // translational EOM:  V_dot = F/m + g - omega × V
    const p = this.p, qr = this.q_rate, r = this.r;
    u += (ax - (qr * w - r * v)) * dt;
    v += (ay - (r * u - p * w)) * dt;
    w += (az - (p * v - qr * u)) * dt;
    this.uvw = [u, v, w];

    // aerodynamic moments (nondimensional rates)
    const phat = p * b / (2 * Vsafe), qhat = qr * c / (2 * Vsafe), rhat = r * b / (2 * Vsafe);
    const Cl = D.Clbeta * this.beta + D.Clp * phat + D.Clr * rhat + D.Clda * this.surf.aileron + D.Cldr * this.surf.rudder;
    const Cm = D.Cm0 + D.Cmalpha * this.alpha + D.Cmq * qhat + D.Cmde * this.surf.elevator + D.Cmflap * this.surf.flap;
    const Cn = D.Cnbeta * this.beta + D.Cnp * phat + D.Cnr * rhat + D.Cnda * this.surf.aileron + D.Cndr * this.surf.rudder;
    const Lm = qbar * S * b * Cl, Mm = qbar * S * c * Cm, Nm = qbar * S * b * Cn;

    // rotational EOM (diagonal inertia): I·ω_dot = M − ω×(I·ω)
    const [Ix, Iy, Iz] = this.I;
    this.p += ((Lm - (Iz - Iy) * qr * r) / Ix) * dt;
    this.q_rate += ((Mm - (Ix - Iz) * p * r) / Iy) * dt;
    this.r += ((Nm - (Iy - Ix) * p * qr) / Iz) * dt;
    // gentle wing-leveler autopilot
    if (this.autopilotLevel) {
      this.p = damp(this.p, -this._euler.phi * 1.5, 3, dt);
    }

    // integrate attitude quaternion:  q_dot = 0.5 · q ⊗ (0,ω)
    const wq = [0, this.p, this.q_rate, this.r];
    const qd = qMul(this.q, wq);
    this.q = qNorm([this.q[0] + 0.5 * qd[0] * dt, this.q[1] + 0.5 * qd[1] * dt, this.q[2] + 0.5 * qd[2] * dt, this.q[3] + 0.5 * qd[3] * dt]);

    this.V = Math.hypot(u, v, w);
    // structural failure: pulling too many G or blowing past never-exceed speed
    if (this.loadFactor > 15 || this.V > ac.vne * 1.4) this.crashed = true;
    this._integratePosition(dt);
    this._updateEuler();

    // ground impact
    if (this.height <= groundH) {
      const sink = -this.verticalSpeed;
      this.height = groundH; this.onGround = true;
      this.uvw = [Math.hypot(u, v, w) * 0.9, 0, 0];
      this.p = this.q_rate = this.r = 0;
      this._euler.theta = 2 * DEG; this._euler.phi = 0;
      this.q = qFromEuler(this._euler.psi, this._euler.theta, 0);
      if (sink > 7 || this.loadFactor > 5 || Math.abs(this._euler.phi) > 50 * DEG) this.crashed = true;
    }
  }

  _integratePosition(dt) {
    const R = matFromQ(this.q);
    const vned = matVec(R, this.uvw);             // [vN, vE, vD]
    this.lat += (vned[0] * dt) / (R_EARTH + this.height);
    this.lon += (vned[1] * dt) / ((R_EARTH + this.height) * Math.cos(this.lat));
    this.height += -vned[2] * dt;
    this.verticalSpeed = -vned[2];
    this.groundSpeed = Math.hypot(vned[0], vned[1]);
  }

  _updateEuler() {
    const R = matFromQ(this.q);
    this._euler = {
      psi: Math.atan2(R[1][0], R[0][0]),
      theta: Math.asin(clamp(-R[2][0], -1, 1)),
      phi: Math.atan2(R[2][1], R[2][2]),
    };
  }

  // ── control inputs ──
  addThrottle(d) { this.throttle = clamp(this.throttle + d, 0, 1); }
  setThrottle(v) { this.throttle = clamp(v, 0, 1); }
  addFlaps(d)    { this.flaps = clamp(this.flaps + d, 0, 1); }
  toggleGear()   { if (!this.onGround) this.gearDown = !this.gearDown; }
  toggleParking(){ this.parkingBrake = !this.parkingBrake; }
  addTrim(d)     { this.trim = clamp(this.trim + d, -0.6, 0.6); }
  toggleAP()     { this.autopilotLevel = !this.autopilotLevel; }

  // ── readouts (same interface the rest of the app expects) ──
  get heading() { return this._euler.psi; }
  get pitch() { return this._euler.theta; }
  get roll() { return this._euler.phi; }
  get headingDeg() { return wrap360(this._euler.psi / DEG); }
  get aoaDeg() { return this.alpha / DEG; }
  get agl() { return this.height - this.terrainHeight; }
  get cartographicDeg() { return { lon: this.lon / DEG, lat: this.lat / DEG, height: this.height }; }
}
