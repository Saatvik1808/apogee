/**
 * LEARNING NOTE: Stability Augmentation (SAS) — a self-tuning attitude controller
 *
 * A 3,900-tonne moon rocket and a one-tonne lunar lander respond to control inputs
 * completely differently. Instead of hand-tuning PID gains, the controller measures
 * its CONTROL AUTHORITY each step: maximum torque (reaction wheels + engine gimbal)
 * divided by moment of inertia gives the maximum angular acceleration α_max.
 *
 * It then uses the "bang-bang with braking" idea from time-optimal control:
 *   desired rate ω* = sign(e) · min(ω_max, √(α_max·|e|), Kp·|e|)
 * i.e. rotate as fast as allowed, but never faster than you can still stop from
 * (v² = 2·a·d). The torque command drives the actual rate toward ω*.
 *
 * Pointing modes (prograde, normal, target...) only constrain the nose direction;
 * roll is merely damped. "Stability" holds the full attitude captured when the
 * pilot last let go of the stick.
 *
 * Key concepts: feedback control, control authority, time-optimal control,
 * axis-angle error from quaternions
 */
import { Quaternion, Vector3 } from 'three';
import { SAS_DECEL_FRACTION, SAS_MAX_RATE } from '../core/constants';
import { clamp } from '../core/math';
import type { ControlCommand, VesselPhysics } from './VesselPhysics';
import type { Vessel } from './Vessel';

const _qInv = new Quaternion();
const _qErr = new Quaternion();
const _err = new Vector3();
const _t = new Vector3();
const _auth = new Vector3();
const Y = new Vector3(0, 1, 0);

export class AttitudeController {
  private readonly holdQ = new Quaternion();
  private holding = false;
  private wasInput = false;
  /** Last pointing error (rad) for UI. */
  error = 0;

  resetHold(v: Vessel): void {
    this.holdQ.copy(v.q);
    this.holding = true;
  }

  /**
   * Compute the attitude command.
   * @param target desired nose direction (inertial, unit) or null for attitude hold
   */
  compute(v: Vessel, physics: VesselPhysics, target: Vector3 | null, out: ControlCommand): ControlCommand {
    const c = v.controls;
    const pilot = Math.abs(c.pitch) + Math.abs(c.yaw) + Math.abs(c.roll) > 0.001;
    out.x = c.pitch;
    out.y = c.roll;
    out.z = -c.yaw;
    if (!c.sas || !v.isControllable) {
      this.holding = false;
      this.wasInput = pilot;
      return out;
    }
    if (pilot) {
      this.wasInput = true;
      this.holding = false;
    } else if (this.wasInput || !this.holding) {
      this.holdQ.copy(v.q);
      this.holding = true;
      this.wasInput = false;
    }

    _qInv.copy(v.q).invert();
    let pointing = false;
    if (target && target.lengthSq() > 0.5) {
      pointing = true;
      _t.copy(target).applyQuaternion(_qInv);
      _err.crossVectors(Y, _t);
      const s = _err.length();
      const ang = Math.atan2(s, Y.dot(_t));
      if (s > 1e-9) _err.multiplyScalar(ang / s);
      else if (ang > 1) _err.set(1, 0, 0).multiplyScalar(ang);
      else _err.set(0, 0, 0);
      this.error = ang;
    } else {
      _qErr.copy(_qInv).multiply(this.holdQ);
      if (_qErr.w < 0) {
        _qErr.x = -_qErr.x;
        _qErr.y = -_qErr.y;
        _qErr.z = -_qErr.z;
        _qErr.w = -_qErr.w;
      }
      const sinHalf = Math.hypot(_qErr.x, _qErr.y, _qErr.z);
      const ang = 2 * Math.atan2(sinHalf, _qErr.w);
      if (sinHalf > 1e-9) _err.set(_qErr.x, _qErr.y, _qErr.z).multiplyScalar(ang / sinHalf);
      else _err.set(0, 0, 0);
      this.error = ang;
    }

    physics.controlAuthority(v, _auth);
    const I = v.inertiaDiag;
    const w = v.w;
    const axis = (e: number, wi: number, tau: number, Ii: number, free: boolean): number => {
      const aMax = tau / Math.max(Ii, 1e-6);
      if (aMax < 1e-7) return 0;
      let wDes = 0;
      if (!free) {
        const mag = Math.min(SAS_MAX_RATE, Math.sqrt(2 * SAS_DECEL_FRACTION * aMax * Math.abs(e)), 2.2 * Math.abs(e));
        wDes = Math.sign(e) * mag;
      }
      const tResp = 0.28;
      return clamp((wDes - wi) / (aMax * tResp), -1, 1);
    };
    const cx = axis(_err.x, w.x, _auth.x, I.x, false);
    const cy = axis(_err.y, w.y, _auth.y, I.y, pointing);
    const cz = axis(_err.z, w.z, _auth.z, I.z, false);
    // Pilot input overrides per axis
    if (Math.abs(c.pitch) < 0.001) out.x = cx;
    if (Math.abs(c.roll) < 0.001) out.y = cy;
    if (Math.abs(c.yaw) < 0.001) out.z = cz;
    return out;
  }
}
