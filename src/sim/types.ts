/** Which control authority currently owns the motors. */
export type FlightMode =
  | 'standby'
  | 'manual'
  | 'cruise'
  | 'dodgr'
  | 'failsafe'
  | 'killed'
  | 'crashed';

/** Laws of the world, all user-tunable at runtime. */
export interface PhysicsParams {
  /** Downward acceleration, m/s^2. */
  gravity: number;
  /** Airframe mass, kg. */
  mass: number;
  /** Combined peak motor thrust, newtons. */
  maxMotorThrust: number;
  /** Lateral air speed, m/s. Negative blows left, positive blows right. */
  wind: number;
  /** Downpour intensity, 0..1. Loads the airframe and thickens the air. */
  rain: number;
  /** Gust intensity, 0..1. Only bites once the drone climbs away from the pad. */
  turbulence: number;
  /** Altitude the autopilot chases, metres above the floor. */
  targetAltitude: number;
}

export type ParamKey = keyof PhysicsParams;

/** Rigid body plus latched mode flags. Mutated in place by the sim loop. */
export interface DroneState {
  /** Lateral position, metres from room centre. */
  x: number;
  /** Skid height above the floor, metres. */
  y: number;
  vx: number;
  vy: number;
  /** Acceleration from the last force sum, m/s^2. */
  ax: number;
  ay: number;
  /** Actual roll angle, radians. Positive tilts right. */
  roll: number;
  /** Roll the controls are asking for, radians. */
  rollCmd: number;
  /** Commanded motor power, 0..1. */
  throttle: number;
  /** Thrust actually produced this step, newtons. */
  thrust: number;

  cruise: boolean;
  /** DODGR mini-game armed: obstacles spawn, weather ramps with altitude. */
  dodgr: boolean;
  /** Target altitude reached in DODGR; hovers and keeps dodging until raised. */
  dodgrWon: boolean;
  failsafe: boolean;
  killed: boolean;
  crashed: boolean;
  landed: boolean;
  /** Fail-safe braking burn has triggered and is latched until touchdown. */
  braking: boolean;

  /** Turbulence gust currently added to the wind, m/s. */
  gust: number;
  /** Gust value the burst is easing toward, m/s. */
  gustTarget: number;
  /** Seconds until the next gust is rolled. */
  gustTimer: number;

  /**
   * Optional battery module. Kept across Reset so the toggle is a sim option,
   * not a flight-mode flag.
   */
  batteryEnabled: boolean;
  /** Remaining pack energy, joules, including the locked reserve. */
  batteryEnergy: number;
  /** Free tumble rate used once the motors are dead, rad/s. */
  tumble: number;
  /** Vertical speed at the moment of impact, m/s. */
  impactSpeed: number;
  /** Rotor animation phase, radians. */
  rotorPhase: number;
  /** Seconds since the sim was reset. */
  elapsed: number;
}

/** Which axes the pilot is physically holding right now. */
export interface PilotInput {
  throttleActive: boolean;
  rollActive: boolean;
}

/** DODGR survival mode for the same tick's autopilot output. */
export type DodgrDodgeMode = 'cruise' | 'hardDodge' | 'holdUnder';

/** Anchor slots for the transient change tabs drawn around the drone. */
export type TabKind =
  | 'gravity'
  | 'mass'
  | 'thrust'
  | 'wind'
  | 'rain'
  | 'turbulence'
  | 'altitude';

export interface ChangeTab {
  kind: TabKind;
  label: string;
  /** -1, 0 or 1: which way the value moved. */
  direction: number;
  /** Sim clock timestamp the tab was (re)raised. */
  born: number;
}

/** Frame snapshot handed to React for the HUD and control read-outs. */
export interface Telemetry {
  altitude: number;
  verticalSpeed: number;
  lateralSpeed: number;
  /** Acceleration from the last force sum, m/s^2. Meaningless while landed. */
  lateralAccel: number;
  verticalAccel: number;
  roll: number;
  rollCmd: number;
  throttle: number;
  thrust: number;
  mode: FlightMode;
  cruise: boolean;
  failsafe: boolean;
  killed: boolean;
  crashed: boolean;
  landed: boolean;
  braking: boolean;
  impactSpeed: number;
  thrustToWeight: number;
  canHover: boolean;
  /** DODGR mini-game armed. */
  dodgr: boolean;
  /** Target altitude reached; hover-and-dodge until the target is raised. */
  dodgrWon: boolean;
  /** Lateral position of the airframe, m from centre. */
  lateralPosition: number;
  /** Lane index the DODGR autopilot is aiming for, 0=left..2=right. -1 if idle. */
  dodgrTargetLane: number;
  /** Peak altitude reached in the current DODGR run, m. */
  dodgrPeakAltitude: number;
  /** ISA static pressure at the current altitude, Pa. */
  airPressure: number;
  /** ISA density at the current altitude, kg/m^3. */
  airDensity: number;
  batteryEnabled: boolean;
  /** Total state of charge, 0..1, including reserve. */
  batterySoc: number;
  /** Usable (non-reserve) state of charge, 0..1. */
  batteryUsableSoc: number;
  batteryInReserve: boolean;
  /** Main pack empty, reserve locked, motors cut. */
  batteryBrownout: boolean;
  /** Seconds of flight left at the current draw, or null if idle / disabled. */
  batterySeconds: number | null;
}
