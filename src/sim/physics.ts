import { densityRatio, isaDensity } from './atmosphere.ts';
import {
  BATTERY_CAPACITY,
  batteryThrustScale,
  drainBattery,
  effectiveMaxThrust,
} from './battery.ts';
import {
  BOUNCE,
  CRASH_LATERAL_SPEED,
  CRASH_ROLL,
  CRASH_SPEED,
  DRAG_X,
  DRAG_Y,
  GROUND_FRICTION,
  RAIN_LATERAL_FRACTION,
  ROLL_GAIN,
  ROLL_RATE_LIMIT,
  SOFT_CEILING,
  WORLD,
} from './constants.ts';
import {
  effectiveWind,
  rainDragScale,
  rainLoad,
  updateGust,
  windLimit,
} from './weather.ts';
import type { DroneState, PhysicsParams } from './types.ts';

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Move `value` toward `target` by at most `maxDelta`. */
export function approach(value: number, target: number, maxDelta: number): number {
  const delta = target - value;
  if (Math.abs(delta) <= maxDelta) return target;
  return value + Math.sign(delta) * maxDelta;
}

/** Height of the first solid surface under a given lateral position. */
export function groundLevelAt(x: number): number {
  return Math.abs(x) <= WORLD.padHalfWidth ? WORLD.padHeight : 0;
}

export function createDroneState(): DroneState {
  const drone: DroneState = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    ax: 0,
    ay: 0,
    roll: 0,
    rollCmd: 0,
    throttle: 0,
    thrust: 0,
    cruise: false,
    dodgr: false,
    dodgrWon: false,
    failsafe: false,
    killed: false,
    crashed: false,
    landed: true,
    braking: false,
    gust: 0,
    gustTarget: 0,
    gustTimer: 0,
    batteryEnabled: false,
    batteryEnergy: BATTERY_CAPACITY,
    tumble: 0,
    impactSpeed: 0,
    rotorPhase: 0,
    elapsed: 0,
  };
  resetDroneState(drone);
  return drone;
}

/**
 * Teleport back to the pad with every flight variable cleared. Battery
 * enable stays put (it is a module switch); the pack itself is refilled.
 */
export function resetDroneState(drone: DroneState): void {
  drone.x = 0;
  drone.y = WORLD.padHeight;
  drone.vx = 0;
  drone.vy = 0;
  drone.ax = 0;
  drone.ay = 0;
  drone.roll = 0;
  drone.rollCmd = 0;
  drone.throttle = 0;
  drone.thrust = 0;
  drone.cruise = false;
  drone.dodgr = false;
  drone.dodgrWon = false;
  drone.failsafe = false;
  drone.killed = false;
  drone.crashed = false;
  drone.landed = true;
  drone.braking = false;
  drone.gust = 0;
  drone.gustTarget = 0;
  drone.gustTimer = 0;
  drone.batteryEnergy = BATTERY_CAPACITY;
  drone.tumble = 0;
  drone.impactSpeed = 0;
  drone.elapsed = 0;
}

/** Lateral aerodynamic force, which is what makes wind felt at all. */
export function lateralDrag(vx: number, wind: number, sigma = 1): number {
  const relative = vx - wind;
  return -DRAG_X * sigma * relative * Math.abs(relative);
}

export function verticalDrag(vy: number, rain = 0, sigma = 1): number {
  return -DRAG_Y * sigma * rainDragScale(rain) * vy * Math.abs(vy);
}

/**
 * Thrust the integrator produces at full throttle, before the tilt cosine.
 * Nameplate thrust is cut by air density and, when the pack is on, by sag.
 * Controllers have to divide by this or they will ask for thrust the step cannot deliver.
 */
export function availableThrust(drone: DroneState, params: PhysicsParams): number {
  return effectiveMaxThrust(drone, params) * densityRatio(drone.y);
}

/**
 * Rain does not fall straight down in a blow. Splits the downpour load into a
 * lateral share that grows with how hard the air is already moving.
 */
export function rainLean(wind: number, params: PhysicsParams): number {
  const limit = windLimit(params);
  if (limit <= 1e-6) return 0;
  return clamp(wind / limit, -1, 1) * RAIN_LATERAL_FRACTION;
}

/** Advance the rigid body one fixed timestep. */
export function stepPhysics(
  drone: DroneState,
  params: PhysicsParams,
  dt: number,
): void {
  const { gravity, mass, maxMotorThrust, rain } = params;
  const powered = !drone.killed && !drone.crashed;
  const ground = groundLevelAt(drone.x);
  const resting = drone.landed && drone.y <= ground + 1e-4;

  updateGust(drone, params, dt);
  const wind = effectiveWind(drone, params);
  const downpour = rainLoad(params);
  const sigma = densityRatio(drone.y);
  const allowReserve = drone.failsafe && powered;

  if (!powered && !drone.landed) {
    // Dead airframe: no attitude authority left, so it tumbles.
    drone.roll += drone.tumble * dt;
  } else if (resting && !drone.crashed) {
    // Skids on the deck hold the airframe level.
    drone.roll += (0 - drone.roll) * Math.min(1, ROLL_GAIN * dt);
  } else if (powered) {
    const rate = clamp(
      (drone.rollCmd - drone.roll) * ROLL_GAIN,
      -ROLL_RATE_LIMIT,
      ROLL_RATE_LIMIT,
    );
    drone.roll += rate * dt;
  }

  const throttle = powered ? clamp(drone.throttle, 0, 1) : 0;
  drone.thrust =
    throttle * maxMotorThrust * sigma * batteryThrustScale(drone, allowReserve);

  const fx =
    drone.thrust * Math.sin(drone.roll) +
    lateralDrag(drone.vx, wind, sigma) +
    downpour * rainLean(wind, params);
  let fy =
    drone.thrust * Math.cos(drone.roll) -
    mass * gravity +
    verticalDrag(drone.vy, rain, sigma) -
    downpour;

  // The deck pushes back instead of letting the airframe sink through it.
  if (resting && fy < 0) fy = 0;

  drone.ax = fx / mass;
  drone.ay = fy / mass;
  drone.vx += drone.ax * dt;
  drone.vy += drone.ay * dt;

  if (resting) {
    drone.vx *= Math.exp(-GROUND_FRICTION * dt);
    if (Math.abs(drone.vx) < 0.02) drone.vx = 0;
  }

  drone.x += drone.vx * dt;
  drone.y += drone.vy * dt;

  const limit = WORLD.halfWidth;
  if (drone.x < -limit) {
    drone.x = -limit;
    drone.vx = Math.abs(drone.vx) * BOUNCE;
  } else if (drone.x > limit) {
    drone.x = limit;
    drone.vx = -Math.abs(drone.vx) * BOUNCE;
  }

  // Open shaft: nothing overhead until the soft cap, which just stops the climb.
  if (drone.y > SOFT_CEILING) {
    drone.y = SOFT_CEILING;
    if (drone.vy > 0) drone.vy = 0;
  }

  const surface = groundLevelAt(drone.x);
  if (drone.y <= surface) {
    const impact = Math.max(-drone.vy, 0);
    drone.y = surface;

    if (!drone.landed) {
      drone.impactSpeed = impact;
      const wrecked =
        impact > CRASH_SPEED ||
        Math.abs(drone.vx) > CRASH_LATERAL_SPEED ||
        Math.abs(drone.roll) > CRASH_ROLL;
      if (wrecked) {
        drone.crashed = true;
        drone.throttle = 0;
        drone.thrust = 0;
      }
      drone.landed = true;
      drone.braking = false;
    }

    drone.vy = 0;
    if (drone.crashed) {
      drone.vx *= Math.exp(-GROUND_FRICTION * 2 * dt);
      const tipDirection = Math.sign(drone.roll || drone.tumble || 1);
      const tipped = tipDirection * 0.44;
      drone.roll += (tipped - drone.roll) * Math.min(1, 4 * dt);
    }
  } else if (drone.y > surface + 1e-4) {
    drone.landed = false;
  }

  drainBattery(drone, drone.thrust, isaDensity(drone.y), dt);

  drone.rotorPhase = (drone.rotorPhase + (1.4 + throttle * 46) * dt) % (Math.PI * 2);
  drone.elapsed += dt;
}
