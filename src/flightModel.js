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
// linear rate-limit: step `c` toward `t` by at most `s` (constant-rate servo travel)
const moveTo = (c, t, s) => (c < t ? Math.min(c + s, t) : Math.max(c - s, t));

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

    // Landing-gear oleo (spring-damper), derived from weight so the cushion feels
    // consistent across aircraft. k & c scale with weight so the strut's natural
    // frequency stays ~8–18 rad/s — rock-solid under explicit Euler at dt=1/120.
    const weight = ac.mass * G;
    this._gearTravel = clamp(0.10 + ac.mass / 320000 * 0.40, 0.10, 0.55); // strut stroke (m)
    this._gearK = weight / (0.30 * this._gearTravel);                     // static sag ≈ 30% of travel
    this._gearC = 2 * 0.72 * Math.sqrt(this._gearK * ac.mass);            // ζ≈0.72 on compression

    // ── MSFS-style control schedules (real detents / limits / response) ──
    const heavy = ac.mass > 20000;
    // Flap DETENTS: each a real handle position {deg, label, vfe(m/s)}. Default to a
    // simple 0/full pair if an aircraft has no schedule yet.
    this.flapDetents = (ac.flaps && ac.flaps.length)
      ? ac.flaps
      : [{ deg: 0, label: '0', vfe: Infinity }, { deg: 40, label: 'FULL', vfe: ac.vne * 0.6 }];
    this.flapDegMax = Math.max(1, ...this.flapDetents.map(d => d.deg));
    this.flapTransitSec = ac.flapTransit || (heavy ? 15 : 5);   // 0 → FULL travel time
    // Landing gear transit + speed limits (m/s). ?? keeps an explicit 0 (fixed gear).
    this.gearTransitSec = ac.gearTransit ?? (heavy ? 10 : 5);
    this.fixedGear = !!ac.fixedGear || this.gearTransitSec <= 0; // e.g. PA-28 (non-retractable)
    this.gearVle = ac.gearVle || ac.vne;                        // max gear-extended speed
    this.gearVlo = ac.gearVlo || this.gearVle;                  // max gear-operating speed
    // Control-surface servo: full travel per second (heavies move a touch slower)
    this.surfaceRate = ac.surfaceRate || (heavy ? 3.0 : 12.0);
    // Engine response: turbofans spool slowly & asymmetrically; pistons ~instant
    this.engineType = ac.engine || (ac.maxThrust > 20000 ? 'turbofan' : 'piston');
    this.spoolUpTau = ac.spoolUp || (this.engineType === 'turbofan' ? 4.5 : 0.5);
    this.spoolDownTau = ac.spoolDown || (this.engineType === 'turbofan' ? 2.2 : 0.4);
    // Powerplant model: a PROP makes thrust from engine power + disk area (lots of
    // thrust slow, little fast); a JET delivers rated static thrust that lapses with
    // density & Mach. Oswald e drives induced drag (was hardcoded 0.8). MMO = Mach limit.
    this.oswaldE = ac.oswaldE || 0.80;
    this.ratedPower = ac.power || 0;                                   // W (prop); 0 ⇒ jet
    this.propArea = ac.propDiam ? Math.PI * ac.propDiam * ac.propDiam / 4 : 0;
    this.mmo = ac.mmo || 0;
  }

  // VFE (max-flap-extended speed, m/s) for the currently-selected detent
  flapVfe() { return this.flapDetents?.[this.flapIndex]?.vfe ?? Infinity; }
  get flapLabel() { return this.flapDetents?.[this.flapIndex]?.label ?? '0'; }

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
    this.thrustFrac = this.throttle;                   // actual delivered thrust (spools toward throttle)
    this.flapIndex = 0; this.flapDeg = 0; this.flaps = 0; // flap detent index / commanded ° / normalized
    this.flapOverspeed = false; this.gearOverspeed = false;
    this.gearDown = true; this.gearPos = 1;            // 0=up, 1=down (animated)
    this.parkingBrake = !airborne; this.wheelBrake = false; this.autopilotLevel = false;
    this.surf = { elevator: 0, aileron: 0, rudder: 0, flap: 0 };  // actual deflections (-1..1)
    this.onGround = !airborne;
    this.terrainHeight = airborne ? height - 500 : height - this.ac.wheelHeight;
    if (!this.wind) this.wind = { n: 0, e: 0, d: 0 }; // NED wind (m/s), set by weather
    this.V = V0; this.ias = V0; this.mach = 0; this.overspeed = false; this.alpha = theta; this.beta = 0;
    this.verticalSpeed = 0; this.groundSpeed = V0;
    this.loadFactor = 1; this.stalled = false; this.crashed = false;
    this._euler = { psi, theta, phi };
    // landing-scorer / cushioned-touchdown state
    this._inContact = false; this._touchCount = 0; this._settleT = 0; this._gearLoad = 0;
    this.lastTouchdown = null; this.justLanded = false;
  }

  update(dt, controls, env) {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.05);
    const ac = this.ac, S = this.S, b = this.b, c = this.c;
    this.terrainHeight = env.terrainHeight;
    const groundH = this.terrainHeight + ac.wheelHeight;
    const weight = ac.mass * G;
    const rho = airDensity(this.height);

    // ── control-surface dynamics (constant-rate servo travel; drives visuals) ──
    // Real surfaces slew at a fixed rate (not exponential easing); control AUTHORITY
    // still scales with dynamic pressure later in the moment build-up.
    const elevCmd = clamp((controls.pitch + this.trim), -1, 1);
    const ailCmd = clamp(controls.roll, -1, 1);
    const rudCmd = clamp(controls.yaw, -1, 1);
    const sStep = this.surfaceRate * dt;
    this.surf.elevator = moveTo(this.surf.elevator, elevCmd, sStep);
    this.surf.aileron = moveTo(this.surf.aileron, ailCmd, sStep);
    this.surf.rudder = moveTo(this.surf.rudder, rudCmd, sStep);
    // Flaps move at constant rate toward the commanded notch — BUT real flaps can't
    // extend against too much air load. Above VFE: freeze further extension, and let
    // air-load "blow back" any excess toward a speed-safe deflection (MSFS-like).
    // VFE/VLE are INDICATED-airspeed limits → compare IAS, not TAS (matters at altitude).
    const vfe = this.flapVfe(), spd = this.V * Math.sqrt(rho / RHO0);
    let flapTgt = this.flaps;
    if (spd > vfe && flapTgt > this.surf.flap) flapTgt = this.surf.flap;    // no extension over VFE
    this.surf.flap = moveTo(this.surf.flap, flapTgt, dt / this.flapTransitSec);
    if (spd > vfe && this.surf.flap > 0) {
      const allow = clamp(1 - (spd - vfe) / (0.25 * vfe), 0, 1);            // blow back
      if (this.surf.flap > allow) this.surf.flap = moveTo(this.surf.flap, allow, 2 * dt / this.flapTransitSec);
    }
    // Gear: fixed gear is welded down; otherwise transit at a constant rate.
    if (this.fixedGear) { this.gearDown = true; this.gearPos = 1; }
    else this.gearPos = moveTo(this.gearPos, this.gearDown ? 1 : 0, dt / this.gearTransitSec);
    // Overspeed flags (mirror MSFS placard warnings): surface deployed AND too fast.
    this.flapOverspeed = this.surf.flap > 0.02 && spd > vfe;
    this.gearOverspeed = !this.fixedGear && this.gearPos > 0.02 && spd > this.gearVle;

    // Gentle hands-off ATTITUDE hold: when you're not touching pitch, lightly damp
    // the pitch rate so the plane holds whatever attitude you set — it stops the
    // slow drift/wandering but does NOT fight a climb or descent you've trimmed in.
    if (!this.onGround && Math.abs(controls.pitch) < 0.04 && this.V > this.ac.stallSpeed * 1.1) {
      this.trim = clamp(this.trim - this.q_rate * 0.22 * dt, -0.55, 0.55);
    }

    // ── current airspeed / flow angles ──
    let [u, v, w] = this.uvw;
    let V = Math.hypot(u, v, w);
    const Vsafe = Math.max(V, 1e-3);
    this.alpha = Math.atan2(w, Math.max(u, 0.1));
    this.beta = Math.asin(clamp(v / Vsafe, -1, 1));
    const qbar = 0.5 * rho * V * V;
    // Indicated airspeed (what the ASI reads & what V-speed/placard limits are in)
    // and true Mach (from ISA temperature) — used for limits, lapse and wave drag.
    this.ias = V * Math.sqrt(rho / RHO0);
    const Tisa = Math.max(216.65, 288.15 - 0.0065 * this.height);
    this.mach = V / Math.sqrt(1.4 * 287 * Tisa);

    // Engine response: thrust lags commanded throttle (turbofans spool slowly and
    // asymmetrically; pistons ~instant).
    const spoolTau = this.thrustFrac < this.throttle ? this.spoolUpTau : this.spoolDownTau;
    this.thrustFrac = damp(this.thrustFrac, this.throttle, 1 / spoolTau, dt);
    let thrust;
    if (this.ratedPower > 0) {
      // PROPELLER (momentum theory): static thrust T0 from power & disk, then a 1/V
      // lapse above the crossover. Power lapses with density (naturally aspirated).
      const Pav = this.thrustFrac * this.ratedPower * (rho / RHO0);
      const T0 = Math.cbrt(2 * rho * this.propArea) * Math.pow(0.85 * Pav, 2 / 3);
      thrust = Math.min(T0, 0.80 * Pav / Math.max(V, 1));
    } else {
      // TURBOFAN: rated static thrust, lapsing with density^0.8 and a small Mach loss.
      thrust = this.thrustFrac * ac.maxThrust * Math.pow(rho / RHO0, 0.8) * Math.max(0.3, 1 - 0.15 * this.mach);
    }

    // ── lift coefficient with smooth stall ──
    // Real flaps: lift rises concavely (early notches add lift cheaply), drag rises
    // convexly (last notches are mostly drag), and the stall AoA drops a couple deg.
    const fL = Math.pow(this.surf.flap, 0.75);          // lift shape
    const fD = this.surf.flap * this.surf.flap;          // drag shape (f^2)
    const alphaStallEff = this.alphaStall - 2 * DEG * this.surf.flap;
    let CL = ac.cl0 + ac.clAlpha * this.alpha + ac.flapClBonus * fL;
    this.stalled = !this.onGround && Math.abs(this.alpha) > alphaStallEff;
    if (Math.abs(this.alpha) > alphaStallEff) {
      const over = Math.abs(this.alpha) - alphaStallEff;
      const decay = Math.max(0.35, 1 - over * 2.5);
      CL = Math.sign(this.alpha) * (ac.cl0 + ac.clAlpha * alphaStallEff + ac.flapClBonus * fL) * decay;
    }
    CL += D.CLq * (this.q_rate * c / (2 * Vsafe));
    // flap/gear over their placard speed adds extra parasitic drag (overspeed penalty)
    const overDrag = (this.flapOverspeed ? ac.flapDrag * 1.2 * (V - this.flapVfe()) / this.flapVfe() * this.surf.flap : 0)
                   + (this.gearOverspeed ? ac.gearDrag * 1.0 * (V - this.gearVle) / this.gearVle * this.gearPos : 0);
    // transonic wave drag (jets only): rises steeply past the critical Mach
    const cdWave = (this.ratedPower === 0 && this.mach > 0.78) ? 20 * Math.pow(this.mach - 0.78, 4) : 0;
    const CD = ac.cd0 + (CL * CL) / (Math.PI * this.oswaldE * this.AR)
             + ac.flapDrag * fD + ac.gearDrag * this.gearPos
             + cdWave + overDrag + (this.stalled ? 0.06 : 0);
    const CY = D.CYbeta * this.beta + D.CYdr * (D.Cndr > 0 ? this.surf.rudder : 0);

    const lift = qbar * S * CL;
    const drag = qbar * S * CD;
    this.loadFactor = lift / weight;

    if (this.onGround && lift < weight * 1.03) {
      // ───────────────── GROUND: constrained, always stable ─────────────────
      this.height = groundH;
      let e = this._euler;
      const rollResist = 0.035 + (this.wheelBrake ? 0.45 : 0) + (this.parkingBrake ? 1.0 : 0);
      const along = thrust - drag - Math.sign(V) * rollResist * weight;
      V = Math.max(0, V + (along / ac.mass) * dt);
      if ((this.parkingBrake || this.wheelBrake) && V < 0.3) V = 0;
      // nosewheel steering — driven by the rudder (Q/E) AND the roll keys
      // (A/D / arrows), so taxiing feels natural. Sharp at taxi speed, gentle at
      // takeoff speed, and none when fully stopped (you have to be rolling).
      const steerIn = clamp(rudCmd + controls.roll, -1, 1);
      const steerAuth = V > 0.2 ? clamp(9 / (V + 5), 0.3, 1.7) : 0;
      e.psi = wrapPi(e.psi + steerIn * 0.4 * steerAuth * dt);
      // Rotation speed scales with the CURRENT-config stall (takeoff flaps lower it,
      // so you rotate sooner — exactly like the real Vr ≈ 1.1·Vs in that config).
      const clMaxCur = ac.clMax + ac.flapClBonus * fL;
      const vRot = Math.sqrt(2 * weight / (rho * S * clMaxCur)) * 1.1;
      // sit level; raise the nose as you pull through rotation speed
      const wantPitch = (V > vRot * 0.6 && controls.pitch > 0.1) ? clamp(controls.pitch, 0, 1) * 12 * DEG : 1.5 * DEG;
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
      const clG = Math.min(ac.cl0 + ac.clAlpha * e.theta + ac.flapClBonus * fL, clMaxCur);
      const liftG = qbar * ac.wingArea * clG;
      if (V > vRot && liftG >= weight) {
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

    // ── landing-gear oleo normal force (spring + damper) ──
    // A one-sided cushion: it only pushes UP, and only when the wheels are at/below
    // the ground. This absorbs the touchdown sink over the strut's travel instead of
    // snapping — soft arrivals barely compress, firm ones load up and gently rebound.
    let gA0 = 0, gA1 = 0, gA2 = 0;
    if (this.height < groundH) {
      const pen = groundH - this.height;            // compression below rest (m)
      const compRate = -this.verticalSpeed;          // +ve = compressing (sinking in)
      const cEff = compRate >= 0 ? this._gearC : this._gearC * 1.25; // firmer on rebound (no pogo)
      let Fn = this._gearK * Math.max(pen, 0) + cEff * compRate;
      if (pen > this._gearTravel * 0.9) Fn += this._gearK * 6 * (pen - this._gearTravel * 0.9); // bottoming bumper
      Fn = clamp(Fn, 0, 8 * weight);                 // never pull down; cap a pathological frame
      this._gearLoad = Fn;
      const gb = matTVec(R, [0, 0, -Fn]);            // NED-up force → body axes
      gA0 = gb[0] / ac.mass; gA1 = gb[1] / ac.mass; gA2 = gb[2] / ac.mass;
    } else this._gearLoad = 0;

    const ax = Fx / ac.mass + gBody[0] + gA0;
    const ay = Fy / ac.mass + gBody[1] + gA1;
    const az = Fz / ac.mass + gBody[2] + gA2;

    // translational EOM:  V_dot = F/m + g - omega × V
    const p = this.p, qr = this.q_rate, r = this.r;
    u += (ax - (qr * w - r * v)) * dt;
    v += (ay - (r * u - p * w)) * dt;
    w += (az - (p * v - qr * u)) * dt;
    this.uvw = [u, v, w];

    // aerodynamic moments (nondimensional rates)
    const phat = p * b / (2 * Vsafe), qhat = qr * c / (2 * Vsafe), rhat = r * b / (2 * Vsafe);
    const Cl = D.Clbeta * this.beta + D.Clp * phat + D.Clr * rhat + D.Clda * this.surf.aileron + D.Cldr * this.surf.rudder;
    const Cm = D.Cm0 + D.Cmalpha * this.alpha + D.Cmq * qhat + D.Cmde * this.surf.elevator + D.Cmflap * fL;
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
    // Overspeed is judged in INDICATED airspeed (VMO) and true Mach (MMO) — the real
    // limits. A warning past the placard; structural failure well past it (≈ Vd/Md).
    this.overspeed = this.ias > ac.vne || (this.mmo > 0 && this.mach > this.mmo);
    if (this.loadFactor > 15 || this.ias > ac.vne * 1.3 || (this.mmo > 0 && this.mach > this.mmo * 1.07)) this.crashed = true;
    this._integratePosition(dt);
    this._updateEuler();

    // ── gear contact: cushioned touchdown (the oleo force above does the work) ──
    if (this.height < groundH) {
      // a fresh wheel contact — the moment of touchdown, or a bounce back down
      if (!this._inContact) {
        this._inContact = true;
        const sink = Math.max(-this.verticalSpeed, 0);          // m/s, +descending
        this._touchCount = (this._touchCount || 0) + 1;
        // weight-dependent impulse model → peak touchdown G (MSFS-Landing-Inspector)
        const impactDur = 0.355 + (-0.103 / (1 + Math.pow(Math.max(ac.mass, 50) / 15463, 1.28)));
        const td = {
          sinkMs: sink, fpm: sink * 196.8503937,
          g: 1 + (2 * sink / impactDur) / G,
          bankDeg: Math.abs(this._euler.phi) / DEG,
          pitchDeg: this._euler.theta / DEG,
          crabDeg: Math.abs(this.beta) / DEG,
          vKt: this.V * 1.943844, vStall: this.ac.stallSpeed,
          gearDown: this.gearDown,
          bounces: this._touchCount - 1,
        };
        // grade the HARDEST touchdown, not the final settle (carry the bounce count)
        if (!this.lastTouchdown || sink > this.lastTouchdown.sinkMs) this.lastTouchdown = td;
        else this.lastTouchdown.bounces = td.bounces;
        // only a genuinely violent arrival collapses the gear — below this the
        // oleo absorbs it and the scorer rates it (a hard landing, not a crash)
        if (sink > 10 || td.bankDeg > 60) this.crashed = true;
      }
      // never tunnel through the strut's mechanical travel
      if (this.height < groundH - this._gearTravel) {
        this.height = groundH - this._gearTravel;
        if (this.verticalSpeed < 0) { this.uvw[2] = Math.min(this.uvw[2], 0); this.verticalSpeed = 0; }
      }
      // settled on the wheels → hand over to the rolling/taxi sub-model
      if (Math.abs(this.verticalSpeed) < 0.5) {
        this._settleT += dt;
        if (this._settleT > 0.12) {
          this.onGround = true;
          this.justLanded = !this.crashed && !!this.lastTouchdown;
          this._inContact = false; this._touchCount = 0; this._settleT = 0;
        }
      } else this._settleT = 0;
    } else {
      if (this._inContact && this.height > groundH + 0.05) this._inContact = false; // bounced clear
      if (this.height > groundH + 60) { this._touchCount = 0; this.lastTouchdown = null; } // go-around resets
    }
  }

  _integratePosition(dt) {
    const R = matFromQ(this.q);
    const vned = matVec(R, this.uvw);             // air-relative velocity [vN, vE, vD]
    // ground track = air velocity + wind (the air mass moves). Aero stays on
    // airspeed (uvw), so you crab into wind and ground speed ≠ airspeed — realistic.
    const wn = this.onGround ? 0 : this.wind.n;
    const we = this.onGround ? 0 : this.wind.e;
    const gN = vned[0] + wn, gE = vned[1] + we;
    this.lat += (gN * dt) / (R_EARTH + this.height);
    this.lon += (gE * dt) / ((R_EARTH + this.height) * Math.cos(this.lat));
    this.height += -vned[2] * dt;
    this.verticalSpeed = -vned[2];
    this.groundSpeed = Math.hypot(gN, gE);
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
  // Flaps step through real DETENTS one notch at a time (d = +1 extend / -1 retract).
  // Returns the new detent label so the UI can confirm the selection.
  addFlaps(d) {
    const dir = Math.sign(d);
    if (!dir || !this.flapDetents) return this.flapLabel;
    const ni = clamp(this.flapIndex + dir, 0, this.flapDetents.length - 1);
    if (ni === this.flapIndex) return this.flapLabel;
    this.flapIndex = ni;
    this.flapDeg = this.flapDetents[ni].deg;
    this.flaps = this.flapDeg / this.flapDegMax;   // normalized command (aero/visual target)
    return this.flapLabel;
  }
  toggleGear()   { if (!this.onGround && !this.fixedGear) this.gearDown = !this.gearDown; }
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
