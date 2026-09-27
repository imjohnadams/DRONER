import type { ParamKey, PhysicsParams } from './types.ts';

/** Warehouse interior, metres. The drone flies in the plane of the back wall. */
export const WORLD = {
  halfWidth: 9,
  /** Raised landing platform at room centre. */
  padHeight: 0.25,
  padHalfWidth: 1.4,
};

/** Slice of the shaft the camera shows at once, metres. */
export const VIEW_HEIGHT = 20;
/** Where the drone rides inside that window. 0 is the bottom edge. */
export const VIEW_FOLLOW = 0.3;
/** Flight ceiling, metres. Climb stops dead here instead of bouncing. */
export const SOFT_CEILING = 100_000;

/** Anything lighter would divide the rigid body by zero. */
export const MIN_MASS = 0.01;

export const DEFAULT_PARAMS: PhysicsParams = {
  gravity: 9.81,
  mass: 1.2,
  maxMotorThrust: 30,
  wind: 0,
  rain: 0,
  turbulence: 0,
  targetAltitude: 6,
};

/**
 * Hard stops only. The sliders pick their own working range around whatever
 * the pilot last typed, so these exist to keep the sim solvable, not to shape
 * the controls. Wind is resolved at runtime against the fightable wind limit.
 */
export const PARAM_LIMITS: Record<ParamKey, { min: number; max: number }> = {
  gravity: { min: 0, max: Number.POSITIVE_INFINITY },
  mass: { min: MIN_MASS, max: Number.POSITIVE_INFINITY },
  maxMotorThrust: { min: 0, max: Number.POSITIVE_INFINITY },
  wind: { min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY },
  rain: { min: 0, max: 1 },
  turbulence: { min: 0, max: 1 },
  targetAltitude: { min: 0, max: SOFT_CEILING },
};

/** Fixed physics timestep, seconds. */
export const DT = 1 / 120;
export const MAX_SUBSTEPS = 6;

/** Peak commandable roll, radians (~32 deg). */
export const MAX_TILT = 0.56;

/** Autopilot always station-keeps to pad centre, never the engage point. */
export const STATION_X = 0;

/**
 * Quadratic drag coefficients at sea level, N per (m/s)^2.
 * Vertical is 0.5 * ρ0 * Cd * A with Cd = 1 and A ≈ 0.04 m² so a 6 m
 * dead-drop still tracks 0.5 g t². Lateral is left alone so the wind
 * slider's fightable range does not jump.
 */
export const DRAG_X = 0.045;
export const DRAG_Y = 0.0245;

/** Combined rotor disk area used by the momentum-theory battery model, m². */
export const ROTOR_DISK_AREA = 0.28;
/** Motor + prop efficiency for electrical power. */
export const BATTERY_ETA = 0.55;
/** Usable hover endurance the pack is sized for, at default mass and g. */
export const BATTERY_HOVER_SECONDS = 240;
/** Locked emergency slice the main flight cannot spend. */
export const BATTERY_RESERVE_FRACTION = 0.2;
/** Peak-thrust scale at empty SOC, before the hard brown-out cut. */
export const BATTERY_SAG_MIN = 0.92;
/** Usable-SOC threshold for the low-battery HUD warning. */
export const BATTERY_LOW_USABLE = 0.3;

/** Roll servo response: first-order chase, rate limited. */
export const ROLL_GAIN = 9;
export const ROLL_RATE_LIMIT = 3.6;

/** Pilot slider slew rates when driven by the arrow keys. */
export const KEY_THROTTLE_RATE = 0.85;
export const KEY_ROLL_RATE = 1.2;

/** Touchdown faster than this wrecks the airframe, m/s. */
export const CRASH_SPEED = 2.6;
/** Lateral scrape limit on touchdown, m/s. */
export const CRASH_LATERAL_SPEED = 4.5;
/** Roll beyond this on touchdown wrecks the airframe, radians (~40 deg). */
export const CRASH_ROLL = 0.7;

/** Cruise altitude hold: position -> climb rate -> acceleration cascade. */
export const ALT_KP = 1.15;
export const ALT_KV = 3.4;
export const MAX_CLIMB_RATE = 3.5;
export const MAX_DESCENT_RATE = 2.4;

/** Cruise station keeping: position -> lateral speed -> acceleration cascade. */
export const POS_KP = 0.95;
export const POS_KV = 1.9;
export const MAX_LATERAL_SPEED = 4;

/** Fail-safe braking burn margin on the computed stopping distance. */
export const BRAKE_SAFETY = 1.45;
/** Extra height added to the trigger so the burn starts a touch early, m. */
export const BRAKE_TRIGGER_PAD = 0.3;
/** Descent rate the braking burn aims to touch down at, m/s. */
export const BRAKE_TOUCHDOWN_SPEED = 0.9;
/** Overshoot on the solved braking deceleration so tracking lag cannot bite. */
export const BRAKE_MARGIN = 1.15;
export const BRAKE_KV = 3.8;

/** Ground friction while resting, per second. */
export const GROUND_FRICTION = 6;
/** Side wall restitution. */
export const BOUNCE = 0.25;

/** Share of the leftover hover margin a 100% downpour eats. */
export const RAIN_LOAD_FRACTION = 0.9;
/** Rain load as a share of weight when there is no hover margin left. */
export const RAIN_FALLBACK_FRACTION = 0.2;
/** How much of the rain load leans sideways when the wind is at its limit. */
export const RAIN_LATERAL_FRACTION = 0.35;
/** Extra vertical drag at 100% rain, as a multiple of the dry coefficient. */
export const RAIN_DRAG_GAIN = 0.6;

/** Peak gust as a share of the fightable wind, at 100% turbulence. */
export const GUST_FRACTION = 0.85;
/** Height over which gusts fade in, metres. */
export const GUST_ALT_SCALE = 14;
/** Seconds between gust re-rolls. */
export const GUST_MIN_PERIOD = 0.35;
export const GUST_MAX_PERIOD = 1.6;
/** First-order chase toward the current gust target, per second. */
export const GUST_RESPONSE = 2.6;

/** How long a physics-change tab stays on screen, seconds. */
export const TAB_TTL = 1.8;

/** Divisor floor so tilt compensation never explodes. */
export const MIN_COS_TILT = 0.35;

// -------------------------------------------------------------------------
// DODGR mini-game
// -------------------------------------------------------------------------

/** Lane centres, metres. Even split of the shaft between the two walls. */
export const DODGR_LANE_X: readonly number[] = [-6, 0, 6];
/** How wide a lane counts as, metres. Just an occupancy hint for spawning. */
export const DODGR_LANE_WIDTH = 6;
/** Airframe hitbox half-extents used for obstacle collision, metres. */
export const DODGR_DRONE_HALF_W = 0.7;
export const DODGR_DRONE_HALF_H = 0.5;
/** Altitude scale for the difficulty curve, metres. */
export const DODGR_DIFFICULTY_SCALE = 32;
/** Altitude below which DODGR keeps weather targets at calm, metres. */
export const DODGR_WEATHER_START = 100;
/** Altitude scale for weather ramp above DODGR_WEATHER_START, metres. */
export const DODGR_WEATHER_SCALE = 400;
/** Minimum vertical gap between branches, metres. */
export const DODGR_BRANCH_MIN_GAP = 5;
/** Spawn interval bounds at min and max difficulty, seconds. */
export const DODGR_SPAWN_MIN = 0.7;
export const DODGR_SPAWN_MAX = 2.6;
/** Highest fraction of the fightable wind DODGR will push through the slider. */
export const DODGR_WIND_FRACTION = 0.6;
/** Weather rate limiter, m/s per second (linear approach toward target). */
export const DODGR_WIND_RATE = 1.2;
/** Rain/turbulence rate, unit per second. */
export const DODGR_ENV_RATE = 0.14;
/** Only push a weather param through setParam when it moves this far. */
export const DODGR_WIND_STEP = 0.02;
export const DODGR_ENV_STEP = 0.005;
/** Peak targets DODGR will drive the weather sliders toward, at max difficulty. */
export const DODGR_MAX_RAIN = 0.9;
export const DODGR_MAX_TURBULENCE = 0.85;

/**
 * Extra seconds on top of a 2-lane bang-bang so the roll servo
 * (ROLL_GAIN / ROLL_RATE_LIMIT) cannot eat the plan.
 */
export const DODGR_LOOKAHEAD_PAD = 0.45;
/** Floor on look-ahead so a punchy craft still sees upcoming threats. */
export const DODGR_LOOKAHEAD_MIN = 2.8;
/** Ceiling so a brick of a craft does not plan the whole shaft. */
export const DODGR_LOOKAHEAD_MAX = 8;
/** Lateral error that still counts as arrived at a committed lane, m. */
export const DODGR_COMMIT_ARRIVE = 1.15;
/** Threats slower than this no longer hold a commit, s. */
export const DODGR_COMMIT_CLEAR_TIME = 0.55;
/** Scrape gap kept under an overhead branch, m. */
export const DODGR_HOLD_UNDER_MARGIN = 0.7;
/** Half-depth of the hold-under pocket; mid-pocket is this far below the ceiling. */
export const DODGR_HOLD_UNDER_MID = 1;
/** Extra clearance when climbing over or ducking under a crosser, m. */
export const DODGR_VERT_DODGE_MARGIN = 0.45;
/** Only slam MAX_TILT when a non-waitable threat is closer than this, s. */
export const DODGR_HARD_THREAT_TIME = 1.1;
/** |x error| above this saturates hard-dodge roll to ±MAX_TILT, m. */
export const DODGR_HARD_ALIGN = 1.4;
/** High-gain station-keep used near the lane during a hard dodge. */
export const DODGR_HARD_POS_KP = 2.8;
export const DODGR_HARD_POS_KV = 5.2;
