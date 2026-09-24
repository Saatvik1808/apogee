/**
 * LEARNING NOTE: Cameras for a planet-scale world
 *
 * An "orbit" camera circles a target at (yaw, pitch, distance). The interesting
 * part is choosing the reference frame: near a planet we measure yaw/pitch
 * relative to the LOCAL HORIZON (up = away from the planet centre, yaw 0 = north),
 * so the horizon stays level however the rocket tumbles. The target is the
 * vessel's interpolated position, so the view is smooth even at 120 Hz with a
 * 60 Hz simulation.
 *
 * The "tower" camera is a fixed spot on the ground near the pad that tracks the
 * rocket as it climbs — the classic launch broadcast shot — until the rocket is
 * too far away. Camera shake is driven by thrust, air density and proximity.
 *
 * The MAP camera frames whole orbits; its distance spans metres to hundreds of
 * millions of kilometres, so zoom is exponential.
 *
 * Key concepts: spherical coordinates, local tangent frames, look-at matrices,
 * exponential zoom, procedural camera shake
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { clamp, damp } from '../core/math';
import type { CelestialBody } from '../physics/CelestialBody';

export type CameraMode = 'chase' | 'tower' | 'free';

const _up = new Vector3();
const _north = new Vector3();
const _east = new Vector3();
const _off = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _tmp = new Vector3();
const ZERO = new Vector3();
const Y_UP = new Vector3(0, 1, 0);

export class FlightCamera {
  mode: CameraMode = 'chase';
  yaw = 200;
  pitch = 8;
  distance = 40;
  targetDistance = 40;
  minDistance = 3;
  fov = 55;
  shake = 0;
  /** One-off jolt (staging, touchdown, nearby explosion); decays in ~0.3 s. */
  impulse = 0;
  /** Absolute camera position. */
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  /** Tower camera position in the body-fixed frame. */
  readonly towerBF = new Vector3();
  private shakeT = 0;

  /** Chase/free orbit update. `target` is absolute. */
  updateOrbit(target: Vector3, body: CelestialBody, dt: number, dragX: number, dragY: number, wheel: number): void {
    this.yaw -= dragX * 0.25;
    this.pitch = clamp(this.pitch + dragY * 0.2, -89, 89);
    if (wheel !== 0) this.targetDistance = clamp(this.targetDistance * Math.pow(1.0015, wheel), this.minDistance, 5e7);
    this.distance += (this.targetDistance - this.distance) * damp(12, dt);
    _up.copy(target).sub(body.position).normalize();
    if (this.mode === 'free') _up.set(0, 1, 0);
    // East = pole × up; north = up × east
    _tmp.set(0, 1, 0).applyQuaternion(body.rotation);
    _east.crossVectors(_tmp, _up);
    if (_east.lengthSq() < 1e-8) _east.set(1, 0, 0);
    _east.normalize();
    _north.crossVectors(_up, _east).normalize();
    const y = (this.yaw * Math.PI) / 180;
    const p = (this.pitch * Math.PI) / 180;
    _off
      .copy(_north)
      .multiplyScalar(Math.cos(y) * Math.cos(p))
      .addScaledVector(_east, Math.sin(y) * Math.cos(p))
      .addScaledVector(_up, Math.sin(p))
      .multiplyScalar(this.distance);
    this.position.copy(target).add(_off);
    _m.lookAt(_tmp.copy(_off).normalize(), ZERO, _up);
    this.quaternion.setFromRotationMatrix(_m);
    this.applyShake(dt);
  }

  /** Fixed ground camera looking at the target. */
  updateTower(target: Vector3, body: CelestialBody, dt: number): void {
    const camAbs = _tmp.copy(this.towerBF).applyQuaternion(body.rotation).add(body.position);
    this.position.copy(camAbs);
    const dir = _off.copy(target).sub(camAbs);
    const d = dir.length();
    _up.copy(camAbs).sub(body.position).normalize();
    _m.lookAt(ZERO, dir.normalize(), _up);
    this.quaternion.setFromRotationMatrix(_m);
    // Zoom lens to keep the rocket framed
    this.fov = clamp((Math.atan2(90, d) * 360) / Math.PI, 3, 55);
    this.applyShake(dt);
  }

  /** Add a jolt; repeated kicks stack up to a cap. */
  kick(amount: number): void {
    this.impulse = Math.min(3, this.impulse + amount);
  }

  private applyShake(dt: number): void {
    this.impulse *= Math.exp(-dt * 7);
    const total = this.shake + this.impulse;
    if (total <= 1e-3) return;
    this.shakeT += dt;
    const a = total * 0.006;
    const t = this.shakeT;
    const rx = (Math.sin(t * 37.1) + Math.sin(t * 61.7) * 0.5) * a;
    const ry = (Math.sin(t * 43.3 + 1.3) + Math.sin(t * 71.9) * 0.5) * a;
    _q.setFromAxisAngle(_tmp.set(1, 0, 0), rx);
    this.quaternion.multiply(_q);
    _q.setFromAxisAngle(_tmp.set(0, 1, 0), ry);
    this.quaternion.multiply(_q);
  }

  /** Place the tower camera ~distance m from the pad, facing it. */
  setupTower(padBF: Vector3, distance: number, height: number, bearingDeg: number): void {
    const up = padBF.clone().normalize();
    const east = new Vector3(up.z, 0, -up.x).normalize();
    const north = new Vector3().crossVectors(up, east).normalize();
    const b = (bearingDeg * Math.PI) / 180;
    this.towerBF
      .copy(padBF)
      .addScaledVector(north, Math.cos(b) * distance)
      .addScaledVector(east, Math.sin(b) * distance)
      .addScaledVector(up, height);
  }
}

/** Map-view camera orbiting a focus point with exponential zoom. */
export class MapCamera {
  yaw = 30;
  pitch = 35;
  distance = 3e7;
  targetDistance = 3e7;
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly focus = new Vector3();

  update(focusAbs: Vector3, dt: number, dragX: number, dragY: number, wheel: number, minDist: number): void {
    this.yaw -= dragX * 0.25;
    this.pitch = clamp(this.pitch + dragY * 0.2, -89, 89);
    if (wheel !== 0) this.targetDistance = clamp(this.targetDistance * Math.pow(1.0018, wheel), minDist, 5e12);
    this.distance = Math.exp(Math.log(this.distance) + (Math.log(this.targetDistance) - Math.log(this.distance)) * damp(10, dt));
    this.focus.copy(focusAbs);
    const y = (this.yaw * Math.PI) / 180;
    const p = (this.pitch * Math.PI) / 180;
    _off.set(Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)).multiplyScalar(this.distance);
    this.position.copy(focusAbs).add(_off);
    _m.lookAt(_tmp.copy(_off).normalize(), ZERO, Y_UP);
    this.quaternion.setFromRotationMatrix(_m);
  }
}
