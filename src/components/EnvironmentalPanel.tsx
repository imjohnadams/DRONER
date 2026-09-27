import type { ChangeEvent } from 'react';
import { peakGust, windLimit } from '../sim/weather.ts';
import type { ParamKey, PhysicsParams } from '../sim/types.ts';

interface EnvironmentalPanelProps {
  params: PhysicsParams;
  onParamChange: (key: ParamKey, value: number) => void;
}

interface WeatherRowProps {
  paramKey: ParamKey;
  label: string;
  readout: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  centered?: boolean;
  onChange: (key: ParamKey, value: number) => void;
}

function WeatherRow({
  paramKey,
  label,
  readout,
  hint,
  value,
  min,
  max,
  step,
  centered,
  onChange,
}: WeatherRowProps) {
  const span = max - min;
  const fraction = span > 0 ? Math.min(Math.max((value - min) / span, 0), 1) : 0;

  return (
    <div className="row">
      <div className="row-head">
        <label htmlFor={`env-${paramKey}`}>{label}</label>
        <span className="row-value">{readout}</span>
      </div>
      <div className={`slider-shell${centered ? ' is-centered' : ''}`}>
        <div
          className="slider-fill"
          style={
            centered
              ? {
                  left: `${Math.min(fraction, 0.5) * 100}%`,
                  width: `${Math.abs(fraction - 0.5) * 100}%`,
                }
              : { left: 0, width: `${fraction * 100}%` }
          }
        />
        <input
          id={`env-${paramKey}`}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange(paramKey, Number(event.target.value))
          }
        />
      </div>
      <p className="row-hint">{hint}</p>
    </div>
  );
}

/** Plain-language name for a downpour so the percentage means something. */
function rainName(rain: number): string {
  if (rain < 0.01) return 'clear';
  if (rain < 0.25) return 'drizzle';
  if (rain < 0.55) return 'steady';
  if (rain < 0.85) return 'heavy';
  return 'hurricane';
}

export function EnvironmentalPanel({
  params,
  onParamChange,
}: EnvironmentalPanelProps) {
  const limit = windLimit(params);
  const gust = peakGust(params);
  const rainPercent = Math.round(params.rain * 100);
  const turbulencePercent = Math.round(params.turbulence * 100);

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Environmental</h2>
        <span className="panel-tag">weather</span>
      </header>

      <WeatherRow
        paramKey="wind"
        label="Wind Speed / Direction"
        readout={
          Math.abs(params.wind) < 0.05
            ? 'calm'
            : `${Math.abs(params.wind).toFixed(1)} m/s ${params.wind < 0 ? 'left' : 'right'}`
        }
        hint={`±${limit.toFixed(1)} m/s · full-thrust tilt limit`}
        value={params.wind}
        min={-limit}
        max={limit}
        step={Math.max(limit / 50, 0.01)}
        centered
        onChange={onParamChange}
      />

      <WeatherRow
        paramKey="rain"
        label="Rain"
        readout={`${rainPercent}% · ${rainName(params.rain)}`}
        hint="loads the airframe and leans with the wind"
        value={params.rain}
        min={0}
        max={1}
        step={0.01}
        onChange={onParamChange}
      />

      <WeatherRow
        paramKey="turbulence"
        label="Turbulence"
        readout={`${turbulencePercent}%`}
        hint={
          turbulencePercent === 0
            ? 'still air · gusts build with altitude'
            : `gusts to ±${gust.toFixed(1)} m/s high up`
        }
        value={params.turbulence}
        min={0}
        max={1}
        step={0.01}
        onChange={onParamChange}
      />
    </section>
  );
}
