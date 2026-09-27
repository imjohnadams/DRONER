/**
 * International Standard Atmosphere (ISA), simplified for a game sim.
 *
 * Troposphere (0..11 km) uses the standard temperature lapse and barometric
 * formula. Above the tropopause we treat the air as isothermal at 216.65 K,
 * which is close enough for the "soft cap" ceiling and keeps a single, cheap
 * expression usable up to the 100 km cap without going negative or blowing up.
 */

/** Sea-level pressure, Pa. */
const P0 = 101_325;
/** Sea-level density, kg/m^3. */
const RHO0 = 1.225;
/** Sea-level temperature, K. */
const T0 = 288.15;
/** Temperature lapse rate in the troposphere, K/m. */
const LAPSE = 0.0065;
/** Standard gravity, m/s^2. */
const G0 = 9.80665;
/** Specific gas constant for dry air, J/(kg*K). */
const R_AIR = 287.05;
/** Tropopause altitude, m. */
const H_TROPOPAUSE = 11_000;
/** Temperature at (and above) the tropopause, K. */
const T_TROPOPAUSE = T0 - LAPSE * H_TROPOPAUSE;

/** Barometric exponent used inside the troposphere. */
const BARO_EXP = G0 / (R_AIR * LAPSE);

/** Pressure at the tropopause, cached so the upper leg starts from it. */
const P_TROPOPAUSE = P0 * Math.pow(T_TROPOPAUSE / T0, BARO_EXP);

/** Scale height for the isothermal upper leg, m. */
const H_SCALE_UPPER = (R_AIR * T_TROPOPAUSE) / G0;

/** ISA static pressure at a given altitude, Pa. */
export function isaPressure(altitude: number): number {
  const h = Math.max(altitude, 0);
  if (h <= H_TROPOPAUSE) {
    const T = T0 - LAPSE * h;
    return P0 * Math.pow(T / T0, BARO_EXP);
  }
  return P_TROPOPAUSE * Math.exp(-(h - H_TROPOPAUSE) / H_SCALE_UPPER);
}

/** ISA temperature at a given altitude, K. */
export function isaTemperature(altitude: number): number {
  const h = Math.max(altitude, 0);
  if (h <= H_TROPOPAUSE) return T0 - LAPSE * h;
  return T_TROPOPAUSE;
}

/** ISA density at a given altitude, kg/m^3. */
export function isaDensity(altitude: number): number {
  return isaPressure(altitude) / (R_AIR * isaTemperature(altitude));
}

/** Density ratio relative to sea level, unitless. Used to scale thrust/drag. */
export function densityRatio(altitude: number): number {
  return isaDensity(altitude) / RHO0;
}
