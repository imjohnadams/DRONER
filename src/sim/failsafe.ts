import {
  BRAKE_KV,
  BRAKE_MARGIN,
  BRAKE_SAFETY,
  BRAKE_TOUCHDOWN_SPEED,
  BRAKE_TRIGGER_PAD,
} from './constants.ts';
import { throttleForDemand, verticalDemand } from './autopilot.ts';
import { availableThrust, clamp, groundLevelAt } from './physics.ts';
import { rainLoad } from './weather.ts';
import type { DroneState, PhysicsParams } from './types.ts';

export interface FailsafeOutput {
  throttle: number;
  rollCmd: number;
  braking: boolean;
}

/**
 * Best sustained upward acceleration at a level attitude, m/s^2.
 * Uses the thrust the integrator will actually produce, and subtracts rain
 * load, which sits on the airframe the same way weight does.
 */
export function brakingAuthority(drone: DroneState, params: PhysicsParams): number {
  const thrust = availableThrust(drone, params);
  const weight = params.mass * params.gravity;
  return (thrust - weight - rainLoad(params)) / params.mass;
}

/**
 * Dead-drop with a last-second braking burn. Motors stay at zero until the
 * airframe is inside the distance it needs to arrest its own descent, then the
 * burn latches on and flies a decelerating profile down to a soft touchdown.
 * If the physics simply cannot stop the fall, the burn never saves it.
 */
export function failsafeControl(
  drone: DroneState,
  params: PhysicsParams,
): FailsafeOutput {
  const authority = brakingAuthority(drone, params);

  if (drone.landed || authority <= 0.15) {
    return { throttle: 0, rollCmd: 0, braking: false };
  }

  const clearance = Math.max(drone.y - groundLevelAt(drone.x), 0);
  const descent = Math.max(-drone.vy, 0);
  const stoppingDistance =
    ((descent * descent) / (2 * authority)) * BRAKE_SAFETY + BRAKE_TRIGGER_PAD;
  const braking = drone.braking || clearance <= stoppingDistance;

  if (!braking) {
    return { throttle: 0, rollCmd: 0, braking: false };
  }

  // Solve the deceleration that actually bleeds the current descent down to the
  // touchdown speed over the remaining clearance. Feeding this forward rather
  // than chasing a velocity profile is what keeps the burn from arriving late.
  const targetAccel =
    descent > BRAKE_TOUCHDOWN_SPEED
      ? clamp(
          ((descent * descent - BRAKE_TOUCHDOWN_SPEED * BRAKE_TOUCHDOWN_SPEED) /
            (2 * Math.max(clearance, 0.05))) *
            BRAKE_MARGIN,
          0,
          authority,
        )
      : clamp((-BRAKE_TOUCHDOWN_SPEED - drone.vy) * BRAKE_KV, -params.gravity, authority);

  return {
    throttle: throttleForDemand(
      verticalDemand(drone, params, targetAccel),
      drone.roll,
      availableThrust(drone, params),
    ),
    // Level out so every newton fights gravity.
    rollCmd: 0,
    braking: true,
  };
}
