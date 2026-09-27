import { memo, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import {
  DODGR_LANE_X,
  TAB_TTL,
  VIEW_FOLLOW,
  VIEW_HEIGHT,
  WORLD,
} from '../sim/constants.ts';
import type { DodgrState, Obstacle } from '../sim/dodgr.ts';
import { clamp, groundLevelAt } from '../sim/physics.ts';
import { effectiveWind, windLimit } from '../sim/weather.ts';
import type { ChangeTab, DroneState, PhysicsParams, TabKind } from '../sim/types.ts';

interface WarehouseViewProps {
  droneRef: RefObject<DroneState>;
  paramsRef: RefObject<PhysicsParams>;
  tabsRef: RefObject<Map<TabKind, ChangeTab>>;
  dodgrRef: RefObject<DodgrState>;
}

/**
 * One-point perspective shaft. r = 1 is the back wall the drone flies in, and
 * the camera shows a VIEW_HEIGHT slice of it that follows the drone up.
 */
interface Camera {
  width: number;
  height: number;
  scale: number;
  originX: number;
  /** World height at the bottom edge of the window, metres. */
  viewBottom: number;
  /** Screen y of that bottom edge. */
  bottomY: number;
  /** Screen y of the warehouse floor. Drops off-screen once the drone climbs. */
  groundY: number;
  /** True while the floor and pad are still inside the window. */
  grounded: boolean;
  vpX: number;
  vpY: number;
  left: number;
  right: number;
  top: number;
}

/** Simulated room depth toward the viewer, metres. */
const ROOM_DEPTH = 20;
const DEPTH_STEP = 1;
const R_MAX = 8;
const PAD_DEPTH_R = 1.22;

/** Wall seams and altitude ticks, metres. */
const SEAM_STEP = 5;

/** Airframe geometry, metres. Local origin sits at the skid contact point. */
const SPAN = 1.25;
const COM_HEIGHT = 0.3;

const MONO = '"JetBrains Mono", "SFMono-Regular", Consolas, monospace';

const TAB_STYLE: Record<TabKind, { accent: string; offsetX: number; offsetY: number }> = {
  gravity: { accent: '#a78bfa', offsetX: -2.7, offsetY: 0.45 },
  mass: { accent: '#f0abfc', offsetX: 0, offsetY: 2 },
  thrust: { accent: '#22d3ee', offsetX: 0, offsetY: -1.35 },
  wind: { accent: '#5eead4', offsetX: 2.7, offsetY: 0.45 },
  rain: { accent: '#60a5fa', offsetX: 2.7, offsetY: -1.1 },
  turbulence: { accent: '#c4b5fd', offsetX: -2.7, offsetY: -1.1 },
  altitude: { accent: '#fbbf24', offsetX: 0, offsetY: 0 },
};

type ParticleKind = 'wash' | 'wind' | 'rain';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  span: number;
  size: number;
  kind: ParticleKind;
}

function makeCamera(width: number, height: number, droneY: number): Camera {
  const scale = Math.min(
    (height * 0.94) / VIEW_HEIGHT,
    (width * 0.98) / (WORLD.halfWidth * 2),
  );
  const windowHeight = VIEW_HEIGHT * scale;
  // Near the pad the floor stays in frame; above that the shaft scrolls past.
  const viewBottom = Math.max(0, droneY - VIEW_HEIGHT * VIEW_FOLLOW);
  const originX = width / 2;
  const bottomY = height * 0.5 + windowHeight * 0.5;
  return {
    width,
    height,
    scale,
    originX,
    viewBottom,
    bottomY,
    groundY: bottomY + viewBottom * scale,
    grounded: viewBottom <= 1e-6,
    vpX: originX,
    vpY: bottomY - windowHeight * VIEW_FOLLOW,
    left: originX - WORLD.halfWidth * scale,
    right: originX + WORLD.halfWidth * scale,
    top: bottomY - windowHeight,
  };
}

const px = (cam: Camera, x: number) => cam.originX + x * cam.scale;
const py = (cam: Camera, y: number) => cam.bottomY - (y - cam.viewBottom) * cam.scale;

/** World heights of the wall seams currently inside the window. */
function seamLevels(cam: Camera): number[] {
  const levels: number[] = [];
  const first = Math.ceil(cam.viewBottom / SEAM_STEP);
  const last = Math.floor((cam.viewBottom + VIEW_HEIGHT) / SEAM_STEP);
  for (let i = first; i <= last; i += 1) levels.push(i * SEAM_STEP);
  return levels;
}

/** Push a back-wall point toward the viewer along its perspective ray. */
function expandX(cam: Camera, x: number, r: number) {
  return cam.vpX + (x - cam.vpX) * r;
}
function expandY(cam: Camera, y: number, r: number) {
  return cam.vpY + (y - cam.vpY) * r;
}

function depthRatios(): number[] {
  const ratios: number[] = [];
  for (let i = 0; i < 40; i += 1) {
    const remaining = ROOM_DEPTH - i * DEPTH_STEP;
    if (remaining <= 0) break;
    const r = ROOM_DEPTH / remaining;
    if (r > 2.8) break;
    ratios.push(r);
  }
  return ratios;
}

const DEPTHS = depthRatios();

function polygon(ctx: CanvasRenderingContext2D, points: number[][]) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
}

function ray(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  x: number,
  y: number,
  from: number,
  to: number,
) {
  ctx.beginPath();
  ctx.moveTo(expandX(cam, x, from), expandY(cam, y, from));
  ctx.lineTo(expandX(cam, x, to), expandY(cam, y, to));
  ctx.stroke();
}

function drawShell(ctx: CanvasRenderingContext2D, cam: Camera) {
  const { left, right, top, bottomY, groundY } = cam;

  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, cam.width, cam.height);

  const corners = {
    bl: [left, bottomY],
    br: [right, bottomY],
    tl: [left, top],
    tr: [right, top],
  };
  const out = (p: number[]) => [
    expandX(cam, p[0], R_MAX),
    expandY(cam, p[1], R_MAX),
  ];

  // Side walls, biased so the shaft reads as a box rather than a flat card.
  polygon(ctx, [corners.tl, corners.bl, out(corners.bl), out(corners.tl)]);
  ctx.fillStyle = '#080e15';
  ctx.fill();
  polygon(ctx, [corners.tr, corners.br, out(corners.br), out(corners.tr)]);
  ctx.fillStyle = '#0b131b';
  ctx.fill();

  // Floor plane, only while the pad is still under the window.
  if (cam.grounded) {
    polygon(ctx, [corners.bl, corners.br, out(corners.br), out(corners.bl)]);
    const floor = ctx.createLinearGradient(0, groundY, 0, cam.height);
    floor.addColorStop(0, '#0e161f');
    floor.addColorStop(1, '#05080c');
    ctx.fillStyle = floor;
    ctx.fill();
  }

  // Back wall.
  const wall = ctx.createLinearGradient(0, top, 0, bottomY);
  wall.addColorStop(0, '#16202b');
  wall.addColorStop(0.55, '#101923');
  wall.addColorStop(1, '#0a1017');
  ctx.fillStyle = wall;
  ctx.fillRect(left, top, right - left, bottomY - top);

  // The shaft keeps going past the window, so bleed the wall out instead of
  // capping it with a hard edge.
  const bleed = Math.min(cam.height * 0.12, 90);
  const above = ctx.createLinearGradient(0, top, 0, top - bleed);
  above.addColorStop(0, '#16202b');
  above.addColorStop(1, 'rgba(22, 32, 43, 0)');
  ctx.fillStyle = above;
  ctx.fillRect(left, top - bleed, right - left, bleed);

  if (!cam.grounded) {
    const below = ctx.createLinearGradient(0, bottomY, 0, bottomY + bleed);
    below.addColorStop(0, '#0a1017');
    below.addColorStop(1, 'rgba(10, 16, 23, 0)');
    ctx.fillStyle = below;
    ctx.fillRect(left, bottomY, right - left, bleed);
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera) {
  const { left, right, top, bottomY, groundY } = cam;
  const levels = seamLevels(cam);
  ctx.lineWidth = 1;

  if (cam.grounded) {
    // Floor: rails running away from the viewer, plus depth cross-lines.
    ctx.strokeStyle = 'rgba(94, 234, 212, 0.07)';
    for (let x = -WORLD.halfWidth; x <= WORLD.halfWidth + 0.001; x += 1.5) {
      ray(ctx, cam, px(cam, x), groundY, 1, R_MAX);
    }
    for (const r of DEPTHS) {
      if (r === 1) continue;
      ctx.beginPath();
      ctx.moveTo(expandX(cam, left, r), expandY(cam, groundY, r));
      ctx.lineTo(expandX(cam, right, r), expandY(cam, groundY, r));
      ctx.stroke();
    }
  }

  // Side wall panel lines, repeating through whatever slice is on screen.
  ctx.strokeStyle = 'rgba(148, 180, 210, 0.05)';
  for (const level of levels) {
    ray(ctx, cam, left, py(cam, level), 1, R_MAX);
    ray(ctx, cam, right, py(cam, level), 1, R_MAX);
  }

  // Shaft corners. No top or bottom edge: the walls run past the window.
  ctx.strokeStyle = 'rgba(120, 190, 220, 0.16)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottomY);
  ctx.moveTo(right, top);
  ctx.lineTo(right, bottomY);
  ctx.stroke();

  // Back wall seams: uprights plus a course line at every tick height.
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(120, 190, 220, 0.07)';
  ctx.beginPath();
  for (let x = -WORLD.halfWidth + 3; x < WORLD.halfWidth; x += 3) {
    ctx.moveTo(px(cam, x), top);
    ctx.lineTo(px(cam, x), bottomY);
  }
  for (const level of levels) {
    const y = py(cam, level);
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.stroke();

  if (cam.grounded) {
    // Service band skirting the floor.
    const bandTop = py(cam, 1.6);
    ctx.fillStyle = 'rgba(94, 234, 212, 0.03)';
    ctx.fillRect(left, bandTop, right - left, groundY - bandTop);
    ctx.strokeStyle = 'rgba(94, 234, 212, 0.12)';
    ctx.beginPath();
    ctx.moveTo(left, bandTop);
    ctx.lineTo(right, bandTop);
    ctx.stroke();
  }
}

function drawPad(ctx: CanvasRenderingContext2D, cam: Camera) {
  const half = WORLD.padHalfWidth;
  const topY = py(cam, WORLD.padHeight);
  const a = [px(cam, -half), topY];
  const b = [px(cam, half), topY];
  const an = [expandX(cam, a[0], PAD_DEPTH_R), expandY(cam, a[1], PAD_DEPTH_R)];
  const bn = [expandX(cam, b[0], PAD_DEPTH_R), expandY(cam, b[1], PAD_DEPTH_R)];
  const af = [
    expandX(cam, px(cam, -half), PAD_DEPTH_R),
    expandY(cam, cam.groundY, PAD_DEPTH_R),
  ];
  const bf = [
    expandX(cam, px(cam, half), PAD_DEPTH_R),
    expandY(cam, cam.groundY, PAD_DEPTH_R),
  ];

  // Riser facing the viewer.
  polygon(ctx, [an, bn, bf, af]);
  ctx.fillStyle = '#111a24';
  ctx.fill();
  ctx.strokeStyle = 'rgba(94, 234, 212, 0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Deck surface.
  polygon(ctx, [a, b, bn, an]);
  ctx.fillStyle = '#16212d';
  ctx.fill();
  ctx.strokeStyle = 'rgba(94, 234, 212, 0.3)';
  ctx.stroke();

  ctx.strokeStyle = 'rgba(94, 234, 212, 0.22)';
  ctx.beginPath();
  ctx.moveTo((a[0] + an[0]) / 2, (a[1] + an[1]) / 2);
  ctx.lineTo((b[0] + bn[0]) / 2, (b[1] + bn[1]) / 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(94, 234, 212, 0.4)';
  ctx.font = `500 ${Math.max(8, cam.scale * 0.26).toFixed(0)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('PAD 01', (a[0] + b[0] + an[0] + bn[0]) / 4, (a[1] + bn[1]) / 2 + 1);
}

function drawAltitudeRuler(ctx: CanvasRenderingContext2D, cam: Camera) {
  const x = cam.left + 12;
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, cam.top);
  ctx.lineTo(x, cam.bottomY);
  ctx.stroke();

  ctx.font = `500 10px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const level of seamLevels(cam)) {
    const sy = py(cam, level);
    const major = level % (SEAM_STEP * 5) === 0;
    ctx.strokeStyle = `rgba(125, 211, 252, ${major ? 0.3 : 0.16})`;
    ctx.beginPath();
    ctx.moveTo(x, sy);
    ctx.lineTo(x + (major ? 12 : 6), sy);
    ctx.stroke();
    ctx.fillStyle = `rgba(148, 190, 214, ${major ? 0.62 : 0.4})`;
    ctx.fillText(`${level}`, x + 16, sy);
  }
}

function drawTargetLine(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  target: number,
  emphasis: number,
) {
  const y = py(cam, clamp(target, cam.viewBottom, cam.viewBottom + VIEW_HEIGHT));
  const alpha = 0.28 + emphasis * 0.5;

  ctx.save();
  ctx.setLineDash([10, 8]);
  ctx.lineWidth = 1 + emphasis * 1.4;
  ctx.strokeStyle = `rgba(251, 191, 36, ${alpha.toFixed(3)})`;
  ctx.beginPath();
  ctx.moveTo(cam.left + 4, y);
  ctx.lineTo(cam.right - 4, y);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = `rgba(251, 191, 36, ${(0.55 + emphasis * 0.45).toFixed(3)})`;
  ctx.beginPath();
  ctx.moveTo(cam.right - 4, y);
  ctx.lineTo(cam.right - 14, y - 5);
  ctx.lineTo(cam.right - 14, y + 5);
  ctx.closePath();
  ctx.fill();

  ctx.font = `600 10px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`TARGET ${target.toFixed(1)}M`, cam.right - 18, y - 4);
}

function drawShadow(ctx: CanvasRenderingContext2D, cam: Camera, drone: DroneState) {
  const surface = groundLevelAt(drone.x);
  const clearance = Math.max(drone.y - surface, 0);
  const fade = 1 / (1 + clearance * 0.35);
  const rx = SPAN * 0.62 * cam.scale * (0.7 + fade * 0.5);

  ctx.save();
  ctx.translate(px(cam, drone.x), py(cam, surface));
  ctx.scale(1, 0.24);
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  grad.addColorStop(0, `rgba(0, 0, 0, ${(0.5 * fade).toFixed(3)})`);
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function ledColor(drone: DroneState): string {
  if (drone.crashed) return '#f43f5e';
  if (drone.killed) return '#ef4444';
  if (drone.failsafe) return '#fbbf24';
  if (drone.cruise) return '#22d3ee';
  return '#e2f4ff';
}

function drawRotor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  phase: number,
  spin: number,
  far: boolean,
) {
  const dim = far ? 0.45 : 1;
  ctx.save();
  ctx.translate(x, y);

  if (spin > 0.02) {
    ctx.fillStyle = `rgba(226, 244, 255, ${((0.04 + spin * 0.1) * dim).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, radius, radius * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = far ? '#7d8fa0' : '#dbe6f0';
  ctx.lineWidth = 0.02;
  ctx.beginPath();
  ctx.moveTo(-radius, 0);
  ctx.lineTo(radius, 0);
  ctx.stroke();

  // Blade tips read as position markers so the spin is legible.
  for (const side of [1, -1]) {
    const tip = Math.cos(phase) * radius * side;
    ctx.fillStyle = `rgba(255, 255, 255, ${(0.85 * dim).toFixed(2)})`;
    ctx.beginPath();
    ctx.ellipse(tip, 0, radius * 0.13, 0.024, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawArmAssembly(
  ctx: CanvasRenderingContext2D,
  drone: DroneState,
  far: boolean,
  throttle: number,
) {
  const lift = far ? 0.09 : 0;
  const reach = SPAN / 2 - (far ? 0.16 : 0);
  const shade = far ? '#9fb0c0' : '#eef4fa';
  const edge = far ? '#66788a' : '#8fa3b6';

  for (const side of [-1, 1]) {
    const tipX = side * reach;
    const tipY = 0.44 + lift;

    ctx.fillStyle = shade;
    ctx.strokeStyle = edge;
    ctx.lineWidth = 0.016;
    ctx.beginPath();
    ctx.moveTo(side * 0.16, 0.36 + lift);
    ctx.lineTo(tipX, tipY - 0.035);
    ctx.lineTo(tipX, tipY + 0.035);
    ctx.lineTo(side * 0.16, 0.44 + lift);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Motor can.
    ctx.fillStyle = far ? '#1d2836' : '#2f3d4a';
    ctx.beginPath();
    ctx.roundRect(tipX - 0.055, tipY, 0.11, 0.1, 0.03);
    ctx.fill();

    drawRotor(
      ctx,
      tipX,
      tipY + 0.13,
      far ? 0.25 : 0.3,
      far ? -drone.rotorPhase : drone.rotorPhase,
      throttle,
      far,
    );
  }
}

/** Nested translucent cones fake a soft-edged downwash without a blur filter. */
const WASH_LAYERS = [
  { half: 0.085, spread: 0.05, alpha: 0.26, reach: 1 },
  { half: 0.15, spread: 0.1, alpha: 0.12, reach: 0.84 },
  { half: 0.225, spread: 0.16, alpha: 0.05, reach: 0.66 },
];

function drawPlumes(ctx: CanvasRenderingContext2D, throttle: number, time: number) {
  if (throttle < 0.02) return;

  for (const side of [-1, 1]) {
    const x = (side * SPAN) / 2;
    const flicker = 1 + Math.sin(time * 24 + side * 1.7) * 0.06;
    const length = (0.26 + throttle * 1.2) * flicker;

    for (const layer of WASH_LAYERS) {
      const tip = length * layer.reach;
      const grad = ctx.createLinearGradient(x, 0.42, x, 0.42 - tip);
      grad.addColorStop(
        0,
        `rgba(168, 232, 255, ${(layer.alpha * throttle).toFixed(3)})`,
      );
      grad.addColorStop(1, 'rgba(140, 210, 255, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x - layer.half, 0.42);
      ctx.lineTo(x + layer.half, 0.42);
      ctx.lineTo(x + layer.half + layer.spread, 0.42 - tip);
      ctx.lineTo(x - layer.half - layer.spread, 0.42 - tip);
      ctx.closePath();
      ctx.fill();
    }

    const core = ctx.createRadialGradient(x, 0.45, 0, x, 0.45, 0.24);
    core.addColorStop(0, `rgba(228, 250, 255, ${(0.28 * throttle).toFixed(3)})`);
    core.addColorStop(1, 'rgba(228, 250, 255, 0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(x, 0.45, 0.24, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawDrone(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  drone: DroneState,
  time: number,
) {
  const throttle = clamp(drone.thrust > 0 ? drone.throttle : 0, 0, 1);

  ctx.save();
  ctx.translate(px(cam, drone.x), py(cam, drone.y));
  ctx.scale(cam.scale, -cam.scale);
  ctx.translate(0, COM_HEIGHT);
  ctx.rotate(-drone.roll);
  ctx.translate(0, -COM_HEIGHT);
  ctx.lineJoin = 'round';

  drawPlumes(ctx, throttle, time);
  drawArmAssembly(ctx, drone, true, throttle);

  // Skids and legs.
  ctx.strokeStyle = '#94a5b6';
  ctx.lineWidth = 0.03;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 0.11, 0.24);
    ctx.lineTo(side * 0.24, 0.03);
    ctx.stroke();
  }
  ctx.fillStyle = '#c9d6e2';
  ctx.beginPath();
  ctx.roundRect(-0.34, 0, 0.68, 0.05, 0.025);
  ctx.fill();

  // Body pod.
  const shell = ctx.createLinearGradient(0, 0.52, 0, 0.22);
  shell.addColorStop(0, '#ffffff');
  shell.addColorStop(0.6, '#eaf1f7');
  shell.addColorStop(1, '#bfcddb');
  ctx.fillStyle = shell;
  ctx.strokeStyle = '#8b9dae';
  ctx.lineWidth = 0.014;
  ctx.beginPath();
  ctx.roundRect(-0.27, 0.22, 0.54, 0.26, 0.09);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#f7fafc';
  ctx.beginPath();
  ctx.roundRect(-0.19, 0.45, 0.38, 0.08, 0.035);
  ctx.fill();
  ctx.strokeStyle = 'rgba(139, 157, 174, 0.7)';
  ctx.stroke();

  drawArmAssembly(ctx, drone, false, throttle);

  // Sensor pod.
  ctx.fillStyle = '#243140';
  ctx.beginPath();
  ctx.arc(0, 0.31, 0.062, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(125, 211, 252, 0.85)';
  ctx.beginPath();
  ctx.arc(-0.018, 0.328, 0.022, 0, Math.PI * 2);
  ctx.fill();

  // Status strip under the pod.
  const led = ledColor(drone);
  const blink = drone.killed || drone.crashed ? 0.45 + Math.sin(time * 9) * 0.4 : 1;
  ctx.globalAlpha = clamp(blink, 0.1, 1);
  ctx.fillStyle = led;
  ctx.beginPath();
  ctx.roundRect(-0.15, 0.2, 0.3, 0.028, 0.014);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.restore();

  // LED bloom, drawn unrotated so the glow stays circular.
  const glowX = px(cam, drone.x);
  const glowY = py(cam, drone.y + 0.21);
  const radius = cam.scale * 0.9;
  const bloom = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, radius);
  bloom.addColorStop(0, `${ledColor(drone)}44`);
  bloom.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(glowX - radius, glowY - radius, radius * 2, radius * 2);
}

function drawParticles(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  particles: Particle[],
) {
  for (const p of particles) {
    const life = clamp(p.life / p.span, 0, 1);
    const x = px(cam, p.x);
    const y = py(cam, p.y);

    if (p.kind === 'wind') {
      ctx.strokeStyle = `rgba(148, 214, 233, ${(life * 0.2).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + p.vx * cam.scale * 0.08, y);
      ctx.stroke();
    } else if (p.kind === 'rain') {
      // Streak runs back along the drop's own velocity, so it leans with the wind.
      const tail = 0.055 * p.size;
      ctx.strokeStyle = `rgba(164, 206, 235, ${(0.34 * p.size).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - p.vx * cam.scale * tail, y + p.vy * cam.scale * tail);
      ctx.stroke();
    } else {
      const size = p.size * cam.scale * (1.6 - life);
      ctx.fillStyle = `rgba(176, 202, 222, ${(life * 0.16).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(x, y, size, size * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawWindBanner(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  wind: number,
  limit: number,
) {
  if (Math.abs(wind) < 0.05) return;
  const right = wind > 0;
  const y = py(cam, cam.viewBottom + VIEW_HEIGHT - 1.6);
  const x = right ? cam.left + 46 : cam.right - 46;
  const dir = right ? 1 : -1;

  ctx.save();
  ctx.globalAlpha = clamp(Math.abs(wind) / Math.max(limit, 1e-6), 0.25, 0.85);
  ctx.strokeStyle = '#5eead4';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 3; i += 1) {
    const cx = x + dir * i * 9;
    ctx.beginPath();
    ctx.moveTo(cx, y - 6);
    ctx.lineTo(cx + dir * 6, y);
    ctx.lineTo(cx, y + 6);
    ctx.stroke();
  }
  ctx.fillStyle = '#5eead4';
  ctx.font = `600 10px ${MONO}`;
  ctx.textAlign = right ? 'left' : 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${Math.abs(wind).toFixed(1)} M/S`, x + dir * 34, y);
  ctx.restore();
}

function drawTab(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  tab: ChangeTab,
  anchorX: number,
  anchorY: number,
  alpha: number,
  slide: number,
) {
  const style = TAB_STYLE[tab.kind];
  const glyph = tab.direction > 0 ? '\u25B2' : tab.direction < 0 ? '\u25BC' : '\u25CF';
  const text = `${glyph} ${tab.label}`;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `600 10px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const padding = 7;
  const width = ctx.measureText(text).width + padding * 2;
  const height = 20;
  const cx = clamp(anchorX, cam.left + width / 2 + 6, cam.right - width / 2 - 6);
  const cy = clamp(anchorY + slide, cam.top + height, cam.bottomY + 40);

  ctx.strokeStyle = `${style.accent}66`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(anchorX, anchorY);
  ctx.lineTo(cx, cy);
  ctx.stroke();

  ctx.fillStyle = 'rgba(6, 11, 17, 0.88)';
  ctx.beginPath();
  ctx.roundRect(cx - width / 2, cy - height / 2, width, height, 4);
  ctx.fill();
  ctx.strokeStyle = style.accent;
  ctx.stroke();

  ctx.fillStyle = style.accent;
  ctx.fillText(text, cx - width / 2 + padding, cy + 1);
  ctx.restore();
}

function drawTabs(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  drone: DroneState,
  params: PhysicsParams,
  tabs: Map<TabKind, ChangeTab>,
  now: number,
) {
  for (const tab of tabs.values()) {
    const age = now - tab.born;
    if (age > TAB_TTL) {
      tabs.delete(tab.kind);
      continue;
    }
    const fadeIn = clamp(age / 0.14, 0, 1);
    const alpha = Math.min(fadeIn, clamp((TAB_TTL - age) / 0.5, 0, 1));
    const slide = (1 - fadeIn) * 10;
    const style = TAB_STYLE[tab.kind];

    if (tab.kind === 'altitude') {
      drawTab(
        ctx,
        cam,
        tab,
        cam.originX,
        py(
          cam,
          clamp(params.targetAltitude, cam.viewBottom, cam.viewBottom + VIEW_HEIGHT),
        ) - 26,
        alpha,
        slide,
      );
      continue;
    }

    drawTab(
      ctx,
      cam,
      tab,
      px(cam, drone.x + style.offsetX),
      py(cam, drone.y + 0.3 + style.offsetY),
      alpha,
      slide,
    );
  }
}

// ---------- DODGR overlay ----------

/** Faint back-wall guides showing the three lane centres the AI aims for. */
function drawLaneGuides(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  targetLane: number,
) {
  ctx.save();
  ctx.setLineDash([6, 10]);
  ctx.lineWidth = 1;
  for (let i = 0; i < DODGR_LANE_X.length; i += 1) {
    const active = i === targetLane;
    ctx.strokeStyle = active
      ? 'rgba(244, 114, 182, 0.55)'
      : 'rgba(244, 114, 182, 0.14)';
    const xPx = px(cam, DODGR_LANE_X[i]);
    ctx.beginPath();
    ctx.moveTo(xPx, cam.top);
    ctx.lineTo(xPx, cam.bottomY);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBranch(ctx: CanvasRenderingContext2D, o: Obstacle) {
  // Rough plank across the lanes it occupies. Drawn in local metres.
  const w = o.halfWidth * 2;
  const h = o.halfHeight * 2;
  const grad = ctx.createLinearGradient(0, -o.halfHeight, 0, o.halfHeight);
  grad.addColorStop(0, '#5a3a24');
  grad.addColorStop(0.5, '#3a2314');
  grad.addColorStop(1, '#25150a');
  ctx.fillStyle = grad;
  ctx.strokeStyle = '#1a0e06';
  ctx.lineWidth = 0.03;
  ctx.beginPath();
  ctx.roundRect(-o.halfWidth, -o.halfHeight, w, h, 0.15);
  ctx.fill();
  ctx.stroke();

  // Bark lines along its length.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = 0.02;
  for (let i = -o.halfWidth + 0.4; i < o.halfWidth - 0.2; i += 0.5) {
    ctx.beginPath();
    ctx.moveTo(i, -o.halfHeight * 0.6);
    ctx.lineTo(i + 0.05, o.halfHeight * 0.6);
    ctx.stroke();
  }
  // Little twigs at the ends.
  ctx.strokeStyle = '#3d2515';
  ctx.lineWidth = 0.04;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * o.halfWidth, 0);
    ctx.lineTo(side * (o.halfWidth + 0.35), -0.35);
    ctx.moveTo(side * o.halfWidth, 0);
    ctx.lineTo(side * (o.halfWidth + 0.4), 0.28);
    ctx.stroke();
  }
}

function drawBird(ctx: CanvasRenderingContext2D, o: Obstacle, time: number) {
  const flap = Math.sin(time * 12) * 0.35;
  const dir = o.vx >= 0 ? 1 : -1;
  ctx.save();
  ctx.scale(dir, 1);
  // Body.
  ctx.fillStyle = '#1b2431';
  ctx.beginPath();
  ctx.ellipse(0, 0, 0.28, 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  // Wings, split so they can flap.
  ctx.fillStyle = '#0d1520';
  ctx.beginPath();
  ctx.moveTo(-0.1, 0);
  ctx.lineTo(-0.55, 0.32 + flap);
  ctx.lineTo(-0.55, 0.06 + flap);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0.05, 0);
  ctx.lineTo(0.55, 0.32 + flap);
  ctx.lineTo(0.55, 0.06 + flap);
  ctx.closePath();
  ctx.fill();
  // Beak.
  ctx.fillStyle = '#fbbf24';
  ctx.beginPath();
  ctx.moveTo(0.28, 0.02);
  ctx.lineTo(0.42, -0.03);
  ctx.lineTo(0.28, -0.07);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPlane(ctx: CanvasRenderingContext2D, o: Obstacle) {
  const dir = o.vx >= 0 ? 1 : -1;
  ctx.save();
  ctx.scale(dir, 1);
  // Fuselage.
  const body = ctx.createLinearGradient(0, -o.halfHeight, 0, o.halfHeight);
  body.addColorStop(0, '#dae3ec');
  body.addColorStop(1, '#8b9dae');
  ctx.fillStyle = body;
  ctx.strokeStyle = '#4a5a6a';
  ctx.lineWidth = 0.03;
  ctx.beginPath();
  ctx.moveTo(-o.halfWidth, 0);
  ctx.lineTo(-o.halfWidth * 0.6, -o.halfHeight * 0.8);
  ctx.lineTo(o.halfWidth * 0.6, -o.halfHeight * 0.6);
  ctx.lineTo(o.halfWidth, 0);
  ctx.lineTo(o.halfWidth * 0.6, o.halfHeight * 0.6);
  ctx.lineTo(-o.halfWidth * 0.6, o.halfHeight * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Cockpit window.
  ctx.fillStyle = 'rgba(125, 211, 252, 0.75)';
  ctx.beginPath();
  ctx.ellipse(o.halfWidth * 0.35, -0.05, 0.18, 0.09, 0, 0, Math.PI * 2);
  ctx.fill();
  // Tail fin.
  ctx.fillStyle = '#4a5a6a';
  ctx.beginPath();
  ctx.moveTo(-o.halfWidth + 0.1, -o.halfHeight * 0.6);
  ctx.lineTo(-o.halfWidth + 0.35, -o.halfHeight * 1.4);
  ctx.lineTo(-o.halfWidth + 0.5, -o.halfHeight * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawDrop(ctx: CanvasRenderingContext2D, o: Obstacle, time: number) {
  // Falling rock / crate. Simple polygon, spinning slowly.
  const spin = time * 1.6 + o.id;
  ctx.save();
  ctx.rotate(spin);
  ctx.fillStyle = '#3b475a';
  ctx.strokeStyle = '#0f1620';
  ctx.lineWidth = 0.04;
  ctx.beginPath();
  const sides = 6;
  for (let i = 0; i < sides; i += 1) {
    const a = (i / sides) * Math.PI * 2;
    const r = o.halfWidth * (0.85 + ((i * 0.13) % 0.2));
    const px_ = Math.cos(a) * r;
    const py_ = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px_, py_);
    else ctx.lineTo(px_, py_);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Highlight facet.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.beginPath();
  ctx.arc(-o.halfWidth * 0.3, -o.halfWidth * 0.3, o.halfWidth * 0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Trailing streak, drawn unrotated so it always points up.
  ctx.strokeStyle = 'rgba(148, 214, 233, 0.28)';
  ctx.lineWidth = 0.06;
  ctx.beginPath();
  ctx.moveTo(0, o.halfHeight);
  ctx.lineTo(0, o.halfHeight + 0.9);
  ctx.stroke();
}

function drawObstacles(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  obstacles: Obstacle[],
  time: number,
) {
  for (const o of obstacles) {
    // Skip anything outside a generous margin of the window.
    if (o.y - o.halfHeight > cam.viewBottom + VIEW_HEIGHT + 4) continue;
    if (o.y + o.halfHeight < cam.viewBottom - 2) continue;

    ctx.save();
    ctx.translate(px(cam, o.x), py(cam, o.y));
    // World-metres coordinate frame with y up (matches drawDrone).
    ctx.scale(cam.scale, -cam.scale);
    ctx.lineJoin = 'round';
    if (o.kind === 'branch') drawBranch(ctx, o);
    else if (o.kind === 'bird') drawBird(ctx, o, time);
    else if (o.kind === 'plane') drawPlane(ctx, o);
    else drawDrop(ctx, o, time);
    ctx.restore();
  }
}

function drawWinBanner(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  time: number,
) {
  const pulse = 0.65 + Math.sin(time * 6) * 0.3;
  ctx.save();
  ctx.globalAlpha = clamp(pulse, 0.35, 1);
  ctx.font = `800 42px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fde68a';
  ctx.shadowColor = 'rgba(251, 191, 36, 0.5)';
  ctx.shadowBlur = 24;
  ctx.fillText('WIN', cam.width / 2, cam.height * 0.28);
  ctx.shadowBlur = 0;
  ctx.font = `600 11px ${MONO}`;
  ctx.fillStyle = '#f9a8d4';
  ctx.fillText(
    'RAISE THE TARGET ALTITUDE TO KEEP CLIMBING',
    cam.width / 2,
    cam.height * 0.28 + 32,
  );
  ctx.restore();
}

function drawStatusOverlay(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  drone: DroneState,
  time: number,
) {
  if (drone.braking) {
    const pulse = 0.55 + Math.sin(time * 14) * 0.35;
    ctx.save();
    ctx.globalAlpha = clamp(pulse, 0.2, 1);
    ctx.fillStyle = '#fbbf24';
    ctx.font = `700 11px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BRAKING BURN', px(cam, drone.x), py(cam, drone.y) + 26);
    ctx.restore();
  }

  if (!drone.crashed) return;

  const vignette = ctx.createRadialGradient(
    cam.width / 2,
    cam.height / 2,
    Math.min(cam.width, cam.height) * 0.25,
    cam.width / 2,
    cam.height / 2,
    Math.max(cam.width, cam.height) * 0.7,
  );
  vignette.addColorStop(0, 'rgba(244, 63, 94, 0)');
  vignette.addColorStop(1, 'rgba(244, 63, 94, 0.16)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, cam.width, cam.height);

  ctx.fillStyle = '#f43f5e';
  ctx.font = `700 11px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const caption = `AIRFRAME LOST \u00B7 IMPACT ${drone.impactSpeed.toFixed(1)} M/S`;
  const halfCaption = ctx.measureText(caption).width / 2;
  ctx.fillText(
    caption,
    clamp(px(cam, drone.x), cam.left + halfCaption + 6, cam.right - halfCaption - 6),
    py(cam, drone.y + 1.15) - 12,
  );
}

/** Drops per second at a full downpour. */
const RAIN_SPAWN_RATE = 110;
const RAIN_FALL_MIN = 7;
const RAIN_FALL_MAX = 17;
const MAX_PARTICLES = 420;

function updateParticles(
  particles: Particle[],
  drone: DroneState,
  params: PhysicsParams,
  cam: Camera,
  carry: { rain: number },
  dt: number,
) {
  const top = cam.viewBottom + VIEW_HEIGHT;

  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const outside =
      Math.abs(p.x) > WORLD.halfWidth + 2 ||
      p.y < cam.viewBottom - 2 ||
      p.y > top + 4;
    if (p.life <= 0 || outside) particles.splice(i, 1);
  }

  if (particles.length > MAX_PARTICLES) {
    particles.splice(0, particles.length - MAX_PARTICLES);
  }

  const wind = effectiveWind(drone, params);
  const surface = groundLevelAt(drone.x);
  const clearance = drone.y - surface;
  if (clearance < 1.8 && drone.throttle > 0.12 && !drone.crashed) {
    const intensity = (1 - clearance / 1.8) * drone.throttle;
    if (Math.random() < intensity * 1.6) {
      const side = Math.random() < 0.5 ? -1 : 1;
      particles.push({
        x: drone.x + side * (0.3 + Math.random() * 0.4),
        y: surface + Math.random() * 0.1,
        vx: side * (1.4 + Math.random() * 3.2),
        vy: 0.2 + Math.random() * 0.8,
        life: 0.55 + Math.random() * 0.55,
        span: 1.1,
        size: 0.16 + Math.random() * 0.2,
        kind: 'wash',
      });
    }
  }

  if (Math.abs(wind) > 0.5) {
    const rate = Math.min(Math.abs(wind) / Math.max(windLimit(params), 1e-6), 1) * 0.9;
    if (Math.random() < rate) {
      particles.push({
        x: wind > 0 ? -WORLD.halfWidth - 1 : WORLD.halfWidth + 1,
        y: cam.viewBottom + 0.6 + Math.random() * (VIEW_HEIGHT - 1.2),
        vx: wind,
        vy: 0,
        life: 2.4,
        span: 2.4,
        size: 0,
        kind: 'wind',
      });
    }
  }

  // Rain enters at the top of the window already moving with the air, so the
  // streaks lean exactly as far as the wind is pushing.
  carry.rain += params.rain * RAIN_SPAWN_RATE * dt;
  const fall = RAIN_FALL_MIN + params.rain * (RAIN_FALL_MAX - RAIN_FALL_MIN);
  while (carry.rain >= 1) {
    carry.rain -= 1;
    if (particles.length >= MAX_PARTICLES) {
      // Drop the backlog rather than dumping it the moment room frees up.
      carry.rain = 0;
      break;
    }
    particles.push({
      x: (Math.random() * 2 - 1) * (WORLD.halfWidth + 1.5),
      y: top + Math.random() * 1.5,
      vx: wind * (0.85 + Math.random() * 0.3),
      vy: -fall * (0.85 + Math.random() * 0.3),
      life: 12,
      span: 12,
      size: 0.55 + Math.random() * 0.45,
      kind: 'rain',
    });
  }
}

export const WarehouseView = memo(function WarehouseView({
  droneRef,
  paramsRef,
  tabsRef,
  dodgrRef,
}: WarehouseViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const particles: Particle[] = [];
    const carry = { rain: 0 };
    let frame = 0;
    let previous = performance.now();
    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      const dt = Math.min((now - previous) / 1000, 0.1);
      previous = now;

      const drone = droneRef.current;
      const params = paramsRef.current;
      const tabs = tabsRef.current;
      const dodgr = dodgrRef.current;
      if (!drone || !params || !tabs || !dodgr) return;

      const time = now / 1000;
      const cam = makeCamera(width, height, drone.y);
      updateParticles(particles, drone, params, cam, carry, dt);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawShell(ctx, cam);
      drawGrid(ctx, cam);
      if (cam.grounded) drawPad(ctx, cam);
      drawAltitudeRuler(ctx, cam);

      // DODGR lane guides live behind obstacles and the drone.
      if (drone.dodgr) drawLaneGuides(ctx, cam, dodgr.targetLane);

      const altitudeTab = tabs.get('altitude');
      const emphasis = altitudeTab
        ? clamp(1 - (time - altitudeTab.born) / TAB_TTL, 0, 1)
        : 0;
      // Keep the target line visible whenever it matters: cruise, DODGR, or a
      // fresh slider change tab. In DODGR we bump the emphasis so the goal is
      // always readable.
      if (drone.cruise || drone.dodgr || emphasis > 0) {
        const bump = drone.dodgr ? Math.max(emphasis, 0.55) : emphasis;
        drawTargetLine(ctx, cam, params.targetAltitude, bump);
      }

      drawParticles(ctx, cam, particles);
      drawWindBanner(ctx, cam, effectiveWind(drone, params), windLimit(params));
      if (cam.grounded) drawShadow(ctx, cam, drone);

      // Draw obstacles under the drone so the airframe reads on top on hit.
      if (dodgr.obstacles.length > 0) {
        drawObstacles(ctx, cam, dodgr.obstacles, time);
      }

      drawDrone(ctx, cam, drone, time);
      drawStatusOverlay(ctx, cam, drone, time);
      drawTabs(ctx, cam, drone, params, tabs, time);

      if (drone.dodgr && drone.dodgrWon && !drone.crashed) {
        drawWinBanner(ctx, cam, time);
      }
    };

    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [droneRef, paramsRef, tabsRef, dodgrRef]);

  return (
    <canvas
      className="warehouse"
      ref={canvasRef}
      role="img"
      aria-label="Warehouse test shaft with the simulated quadcopter"
    />
  );
});
