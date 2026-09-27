# DRONER

Browser quadcopter flight simulator. A 2D side-view drone flies an open warehouse shaft while a dashboard exposes the world parameters and the flight-deck controls.

## Overview

DRONER is a client-side simulator: physics, weather, autopilot, and rendering all run in the browser. There is no backend, no hardware link, and no environment configuration.

The cockpit is a single screen. The centre is a Canvas 2D warehouse shaft. The left rail holds weather sliders and live telemetry. The right rail holds physics sliders and the flight deck. World laws can be retuned mid-flight; cruise mode re-trims around them.

## Features

- 2D warehouse shaft with a following camera and a 100 km climb ceiling
- Live physics sliders: gravity, mass, peak motor thrust, target cruise altitude
- Weather: fightable wind, rain load that leans with the wind, altitude-fading turbulence
- Cruise autopilot that holds target altitude and station-keeps at pad centre
- Drop fail-safe: motors cut, then a last-second braking burn
- Optional battery module: state of charge, thrust sag, locked 20% reserve, brown-out
- Kill (latching power cut) and Reset (back to the pad, slider values kept)
- DODGR climb-and-dodge mini-game on the same rigid body and weather model
- ISA pressure and density telemetry; motor thrust scales with air density

## Tech Stack

- **Frontend:** React, TypeScript, Vite, Canvas 2D
- **Lint:** oxlint
- **Launcher (optional):** Python 3 standard library (`start.py`)

No server, database, or authentication.

## Architecture

`App` composes the cockpit and calls `useSimulation`. That hook owns the drone and parameter refs, a 120 Hz fixed-step loop (`DT = 1/120`, capped substeps), keyboard bindings, and control-authority transitions. Each tick writes motor commands, then `stepPhysics`. React state is a telemetry snapshot for the HUD and panels; the canvas reads the same refs directly.

Control authority is kill > fail-safe > pilot > cruise. A held throttle or tilt only borrows that axis; cruise recaptures it on release. DODGR uses the same autopilot with a lane target instead of the pad centre.

Thrust available this step is nameplate thrust scaled by ISA density (and by battery sag when the pack is on). Wind slider limits are the fastest lateral wind the current motors can still hold against at full tilt.

| Path | Role |
| --- | --- |
| `src/sim/physics.ts` | Rigid-body integration, drag, walls, crash, reset |
| `src/sim/atmosphere.ts` | Simplified ISA pressure, temperature, and density |
| `src/sim/weather.ts` | Wind limits, rain load, gusts |
| `src/sim/battery.ts` | Pack energy, sag, reserve, brown-out |
| `src/sim/autopilot.ts` | Cruise hold and DODGR lane control |
| `src/sim/failsafe.ts` | Last-second braking burn |
| `src/sim/dodgr.ts` | Obstacles, weather ramp, lane planning |
| `src/hooks/useSimulation.ts` | Loop, keyboard, mode transitions |
| `src/components/` | Warehouse canvas, HUD, sliders, flight deck |

`start.py` is not part of the sim. It finds npm, runs `npm install` if `node_modules` is missing, starts `npm run dev`, waits for `http://127.0.0.1:5173`, and opens the default browser.

## Getting Started

**Prerequisites**

- Node.js and npm. Vite 8 in this project requires Node `^20.19.0` or `>=22.12.0`.
- Python 3 only if you use `start.py`. It uses the standard library; nothing is installed with pip.

There are no environment variables.

**Install and run**

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. Vite uses its default port; `vite.config.ts` does not override it.

**Launcher**

```bash
python start.py
```

This installs dependencies if needed, starts the dev server, and opens the app.

**Lint, production build, preview**

```bash
npm run lint
npm run build
npm run preview
```

`npm run build` type-checks with `tsc -b` and writes static files to `dist/`. `npm run preview` serves that build locally.

## Usage

Change physics and weather at any time, including mid-flight. Gravity, mass, max motor thrust, and target altitude use a range that recenters when you type a value: the slider top becomes twice what you entered. Mass cannot go below 0.01 kg. Target altitude stops at the 100 km flight ceiling.

Wind is not a fixed range. Its limits are the fastest lateral wind the current motors can still hold against at full tilt, so lowering max thrust narrows the wind slider.

| Slider | Effect |
| --- | --- |
| Gravity | Downward acceleration |
| Drone Mass | Airframe weight |
| Max Motor Thrust | Peak combined thrust |
| Wind Speed / Direction | Lateral air speed. Negative blows left, positive blows right |
| Rain | Downward load that also leans with the wind |
| Turbulence | Gusts that fade in as the drone climbs off the pad |
| Target Cruise Altitude | Height cruise mode climbs to and holds |

| Control | Keys | Behaviour |
| --- | --- | --- |
| Thrust | Up / Down | Raw motor power. Overrides cruise while held |
| Tilt / Roll | Left / Right | Tilts the airframe to translate laterally |
| Autopilot | C | Holds target altitude and station-keeps against wind |
| Drop | F | Cuts the motors, then fires a last-second braking burn. Auto-arms on usable-pack brown-out so the locked 20% reserve can power the burn |
| Battery | B | Optional pack. Tracks state of charge, thrust sag, and a locked reserve. The switch survives Reset; the pack refills |
| Kill | K | Latching power cut. No recovery until Reset |
| Reset | R | Back to the pad with flight state cleared. Slider values are kept |
| DODGR | D | Climb-and-dodge mini-game. Engages autopilot, spawns obstacles, and ramps weather with altitude. Reaching the target altitude holds a win until the target is raised |

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
