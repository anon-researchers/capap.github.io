import { stateAt } from './replay.js';

// The physical camera reads the long arena dimension from top to bottom.  This
// is the original overhead world, rotated clockwise and then reflected across
// its long axis: screen x = -world y and screen y = world x.
export const FILM_BOUNDS = [-2, 2, -3.5, 3.5];
const VIEWBOX = [420, 680];
const PADDING = 30;
const COLORS = ['#1f77b4', '#ff7f0e'];

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

function finite(value) {
  return Number.isFinite(Number(value));
}

/** Convert a recorded world coordinate into the film's rotated world frame. */
export function worldToFilm([x, y]) {
  return [-Number(y), -Number(x)];
}

/** Convert a recorded heading into the rotated world-frame heading. */
export function worldHeadingToFilm(theta) {
  return -Number(theta) - Math.PI / 2;
}

function layout() {
  const [xmin, xmax, ymin, ymax] = FILM_BOUNDS;
  const [width, height] = VIEWBOX;
  const scale = Math.min(
    (width - PADDING * 2) / (xmax - xmin),
    (height - PADDING * 2) / (ymax - ymin),
  );
  return { scale, cx: width / 2, cy: height / 2 };
}

function screenPoint(point) {
  if (!Array.isArray(point) || !finite(point[0]) || !finite(point[1])) return null;
  const [x, y] = worldToFilm(point);
  const { scale, cx, cy } = layout();
  return [cx + x * scale, cy - y * scale];
}

function polygon(vertices, className) {
  if (!Array.isArray(vertices)) return '';
  const points = vertices.map(screenPoint).filter(Boolean)
    .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return points ? `<polygon points="${points}" class="${className}"/>` : '';
}

function ownerColor(bundle, ownerId) {
  const index = (bundle?.agents || []).findIndex(agent => agent.id === ownerId);
  return COLORS[index < 0 ? 0 : index % COLORS.length];
}

function goal(marker, bundle) {
  const center = marker?.center || marker?.position;
  const position = screenPoint(center);
  if (!position) return '';
  const { scale } = layout();
  const radius = Math.max(3, Number(marker.radius || .2) * scale);
  const color = ownerColor(bundle, marker.agent_id || marker.owner || marker.owner_agent_id);
  return `<circle cx="${position[0].toFixed(2)}" cy="${position[1].toFixed(2)}" r="${radius.toFixed(2)}" class="goal" style="stroke:${color}"/>`;
}

function robot(bundle, agent, pose, spec, label) {
  if (!Array.isArray(pose) || pose.length < 3 || pose.slice(0, 3).some(value => !finite(value))) return '';
  const position = screenPoint(pose);
  const { scale } = layout();
  const halfExtents = spec?.half_extents || [.16, .12];
  const width = Math.max(10, Number(halfExtents[0]) * scale * 2);
  const height = Math.max(10, Number(halfExtents[1]) * scale * 2);
  // SVG's y axis points down, so negate the transformed world heading.
  const svgHeading = -worldHeadingToFilm(Number(pose[2])) * 180 / Math.PI;
  const color = ownerColor(bundle, agent.id);
  const x = position[0];
  const y = position[1];
  return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${svgHeading.toFixed(2)})"><rect x="${(-width / 2).toFixed(2)}" y="${(-height / 2).toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" fill="${color}" stroke="#454545" stroke-width="1.5"/><path d="M ${(width * .13).toFixed(2)} 0 L ${(width * .43).toFixed(2)} 0" stroke="#e5f6f7" stroke-width="4" stroke-linecap="round"/></g><text x="${Math.min(290, x + width / 2 + 8).toFixed(2)}" y="${Math.max(22, y - height / 2 - 8).toFixed(2)}" class="robot-label">${esc(label)}</text>`;
}

function arena() {
  const [xmin, xmax, ymin, ymax] = FILM_BOUNDS;
  const topLeft = screenPoint([-ymax, -xmin]);
  const bottomRight = screenPoint([-ymin, -xmax]);
  return `<rect x="${topLeft[0].toFixed(2)}" y="${topLeft[1].toFixed(2)}" width="${(bottomRight[0] - topLeft[0]).toFixed(2)}" height="${(bottomRight[1] - topLeft[1]).toFixed(2)}" class="arena-border"/>`;
}

/**
 * Render only the latest recorded state at t.  The film deliberately has no
 * interpolation, trails, motion arrows, or other look-ahead annotations.
 */
export function renderFilmScene(svg, bundle, t) {
  if (!svg) return;
  const state = stateAt(bundle, t);
  const scene = bundle?.scene || {};
  const markers = state.frame?.markers ?? state.frame?.state?.markers ?? [];
  const markerRows = Array.isArray(markers) ? markers : Object.values(markers);
  let output = `<style>
    .arena-border { fill:#fff; stroke:#3c3c3c; stroke-width:3; }
    .wall { fill:#3c3c3c; stroke:#3c3c3c; stroke-width:1; }
    .goal { fill:none; stroke-width:3; stroke-dasharray:6 4; }
    .robot-label { font:400 28px Arial,sans-serif; fill:#111; paint-order:stroke; stroke:#fff; stroke-width:3px; stroke-linejoin:round; }
  </style><rect width="420" height="680" fill="#fff"/>${arena()}`;
  for (const wall of scene.walls || []) output += polygon(wall.vertices, 'wall');
  for (const marker of markerRows) output += goal(marker, bundle);
  for (const agent of bundle?.agents || []) {
    const label = agent.id === 'agent_0' ? 'Robot 1' : agent.id === 'agent_1' ? 'Robot 2' : agent.role || agent.id;
    output += robot(bundle, agent, state.frame?.state?.agents?.[agent.id], scene.robots?.[agent.id], label);
  }
  svg.innerHTML = output;
  // Keep labels readable when recorded robot positions approach each other.
  // Only text moves; robot poses, orientation and goals remain trace-exact.
  const labels = [...svg.querySelectorAll('.robot-label')];
  for (let i = 1; i < labels.length; i++) {
    const previous = labels[i - 1].getBBox();
    const current = labels[i].getBBox();
    if (current.x < previous.x + previous.width + 6 && current.x + current.width + 6 > previous.x &&
        current.y < previous.y + previous.height + 6 && current.y + current.height + 6 > previous.y) {
      labels[i].setAttribute('y', Number(labels[i].getAttribute('y')) + previous.y + previous.height + 8 - current.y);
    }
  }
  svg.setAttribute('viewBox', '0 0 420 680');
  svg.setAttribute('aria-label', `Recorded physical robot poses and virtual goals at ${state.t.toFixed(1)} seconds`);
}
