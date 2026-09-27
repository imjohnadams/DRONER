import type { Telemetry } from '../sim/types.ts';

interface StatsPanelProps {
  telemetry: Telemetry;
}

interface VectorStatProps {
  label: string;
  unit: string;
  x: number;
  y: number;
  live: boolean;
}

/** Two-axis read-out that blanks out whenever the airframe is on a surface. */
function VectorStat({ label, unit, x, y, live }: VectorStatProps) {
  return (
    <div className="stat">
      <span className="stat-key">{label}</span>
      {live ? (
        <span className="stat-value">
          <span className="stat-axis">x</span>
          {x.toFixed(2)}
          <span className="stat-axis">y</span>
          {y.toFixed(2)}
          <span className="stat-unit">{unit}</span>
        </span>
      ) : (
        <span className="stat-value is-na">N/A</span>
      )}
    </div>
  );
}

function formatEndurance(seconds: number | null): string {
  if (seconds === null) return '';
  if (seconds >= 90) return ` · ~${(seconds / 60).toFixed(1)} min`;
  return ` · ~${Math.max(0, seconds).toFixed(0)} s`;
}

export function StatsPanel({ telemetry }: StatsPanelProps) {
  const airborne = !telemetry.landed;
  const pressureKpa = telemetry.airPressure / 1000;

  let batteryClass = 'stat-value is-na';
  let batteryText = 'N/A';
  if (telemetry.batteryEnabled) {
    const percent = Math.round(telemetry.batterySoc * 100);
    if (telemetry.batterySoc <= 0) {
      batteryClass = 'stat-value is-danger';
      batteryText = `0%${formatEndurance(telemetry.batterySeconds)}`;
    } else if (telemetry.batteryInReserve || telemetry.batteryBrownout) {
      batteryClass = 'stat-value is-warn';
      batteryText = `RESERVE ${percent}%${formatEndurance(telemetry.batterySeconds)}`;
    } else {
      batteryClass = 'stat-value';
      batteryText = `${percent}%${formatEndurance(telemetry.batterySeconds)}`;
    }
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Statistics</h2>
        <span className="panel-tag">read only</span>
      </header>

      <div className="stat-list">
        <VectorStat
          label="Acceleration"
          unit="m/s²"
          x={telemetry.lateralAccel}
          y={telemetry.verticalAccel}
          live={airborne}
        />
        <VectorStat
          label="Velocity"
          unit="m/s"
          x={telemetry.lateralSpeed}
          y={telemetry.verticalSpeed}
          live={airborne}
        />
        <div className="stat">
          <span className="stat-key">Air Pressure</span>
          <span className="stat-value">
            {pressureKpa.toFixed(2)}
            <span className="stat-unit">kPa</span>
            <span className="stat-unit">{telemetry.airDensity.toFixed(3)} kg/m³</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-key">Battery</span>
          <span className={batteryClass}>{batteryText}</span>
        </div>
      </div>

      <p className="row-hint">
        {airborne ? 'live from the last force sum' : 'airframe on a surface · ISA still live'}
      </p>
    </section>
  );
}
