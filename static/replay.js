// Shared trace replay for the website and film. Poses are never interpolated.
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
const PAPER_COLORS = ['#1f77b4', '#ff7f0e'];

function latestAt(rows, t, field = 't') {
  if (!rows?.length || Number(rows[0]?.[field]) > t) return null;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Number(rows[mid]?.[field]) <= t) lo = mid;
    else hi = mid - 1;
  }
  return rows[lo];
}

export function stateAt(bundle, t) {
  const time = clamp(Number(t) || 0, 0, Number(bundle?.duration) || 0);
  const frame = latestAt(bundle?.frames, time);
  const observations = {};
  for (const agent of bundle?.agents || []) {
    observations[agent.id] = latestAt(
      bundle?.observations?.filter(row => row.agent === agent.id) || [],
      time,
    );
  }
  const activeDeployments = {};
  for (const row of bundle?.deployments || []) {
    if (Number(row.t) <= time) activeDeployments[row.agent] = row;
    else break;
  }
  const calls = (bundle?.calls || []).filter(call =>
    Number(call.start) <= time && (call.end == null || Number(call.end) > time),
  );
  return { t: time, frame, observations, activeDeployments, calls };
}

function point(x, y, bounds) {
  const [xmin, xmax, ymin, ymax] = bounds;
  const scale = Math.min(872 / (xmax - xmin), 612 / (ymax - ymin));
  return [500 - (xmin + xmax) * scale / 2 + x * scale, 370 + (ymin + ymax) * scale / 2 - y * scale, scale];
}

function shapePoly(vertices, bounds, cls) {
  if (!Array.isArray(vertices)) return '';
  const points = vertices.map(vertex => {
    if (!Array.isArray(vertex)) return '';
    return point(Number(vertex[0]), Number(vertex[1]), bounds).slice(0, 2).map(value => value.toFixed(2)).join(',');
  }).filter(Boolean).join(' ');
  return points ? `<polygon points="${points}" class="${cls}"/>` : '';
}

function circle(center, radius, bounds, cls, extra = '') {
  if (!Array.isArray(center)) return '';
  const [x, y, scale] = point(Number(center[0]), Number(center[1]), bounds);
  return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${Math.max(1, Number(radius) * scale).toFixed(2)}" class="${cls}" ${extra}/>`;
}

function label(x, y, value, cls = 'map-label') {
  return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" class="${cls}">${esc(value)}</text>`;
}

function agentColor(bundle, agent) {
  const index = (bundle?.agents || []).findIndex(item => item.id === agent.id);
  return PAPER_COLORS[index < 0 ? 0 : index % PAPER_COLORS.length];
}

function agentLabel(agent) {
  return agent?.model || agent?.role || agent?.id || 'Robot';
}

function robot(bundle, agent, pose, spec, bounds, labelText) {
  if (!Array.isArray(pose) || pose.length < 3 || pose.slice(0, 3).some(value => number(value) == null)) return '';
  const [x, y, scale] = point(Number(pose[0]), Number(pose[1]), bounds);
  const theta = -Number(pose[2]) * 180 / Math.PI;
  const extents = spec?.half_extents || [0.16, 0.12];
  const width = Math.max(8, Number(extents[0]) * scale * 2);
  const height = Math.max(8, Number(extents[1]) * scale * 2);
  const color = agentColor(bundle, agent);
  const body = spec?.kind === 'aerial'
    ? `<path d="M ${(-width * .5).toFixed(2)} ${(-height * .5).toFixed(2)} L ${(width * .5).toFixed(2)} ${(height * .5).toFixed(2)} M ${(width * .5).toFixed(2)} ${(-height * .5).toFixed(2)} L ${(-width * .5).toFixed(2)} ${(height * .5).toFixed(2)}" stroke="${color}" stroke-width="6" stroke-linecap="round"/><circle r="${(Math.min(width, height) * .29).toFixed(2)}" fill="${color}" stroke="#fff" stroke-width="2"/>`
    : `<rect x="${(-width / 2).toFixed(2)}" y="${(-height / 2).toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" fill="${color}" stroke="#454545" stroke-width="1.5"/><path d="M ${(width * .13).toFixed(2)} 0 L ${(width * .43).toFixed(2)} 0" stroke="#e5f6f7" stroke-width="4" stroke-linecap="round"/>`;
  return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)})"><g transform="rotate(${theta.toFixed(2)})">${body}</g></g>${label(Math.min(x + 17, 850), Math.max(34, y - height / 2 - 13), labelText, 'robot-label')}`;
}

function traceTrail(bundle, agent, t, bounds) {
  if (!Array.isArray(bundle?.frames)) return '';
  const step = Math.max(1, Math.floor(bundle.frames.length / 500));
  const points = [];
  let lastTime = -Infinity;
  for (let i = 0; i < bundle.frames.length; i += step) {
    const frame = bundle.frames[i];
    if (Number(frame.t) > t) break;
    const pose = frame.state?.agents?.[agent.id];
    if (!Array.isArray(pose) || Number(frame.t) - lastTime < .25) continue;
    const [x, y] = point(Number(pose[0]), Number(pose[1]), bounds);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    lastTime = Number(frame.t);
  }
  return points.length < 2 ? '' : `<polyline points="${points.join(' ')}" fill="none" stroke="${agentColor(bundle, agent)}" stroke-width="2.5" stroke-opacity=".38" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function sceneFromObservation(observation, fallback) {
  const payload = observation?.payload;
  if (!payload) return null;
  return {
    bounds: payload.static_map?.bounds || fallback?.bounds,
    walls: payload.static_map?.walls || [],
    zones: payload.scenario?.goal ? [payload.scenario.goal] : [],
    obstacles: (payload.moving_obstacles || []).filter(item => item.visible && item.position != null).map(item => ({ ...item, center: item.position })),
    agents: { [payload.agent_id]: payload.self?.pose },
    peers: (payload.peers || []).filter(item => item.visible && item.pose != null),
  };
}

function currentMarkers(frame) {
  const markers = frame?.markers ?? frame?.state?.markers ?? [];
  return Array.isArray(markers) ? markers : Object.values(markers || {});
}

function markerCircle(marker, bounds, bundle) {
  const center = marker?.center || marker?.position;
  if (!Array.isArray(center)) return '';
  const ownerId = marker?.agent_id || marker?.owner || marker?.owner_agent_id;
  const owner = (bundle?.agents || []).find(agent => agent.id === ownerId);
  return circle(center, marker.radius || .2, bounds, 'marker', `stroke="${owner ? agentColor(bundle, owner) : '#555'}"`);
}

function lightGlyph(light, frame, bounds) {
  const position = light?.center || light?.position || light?.xy;
  const value = frame?.lights?.[light?.id] ?? frame?.state?.lights?.[light?.id];
  const state = typeof value === 'string' ? value : value?.state;
  if (!Array.isArray(position) || !state) return '';
  const [x, y] = point(position[0], position[1], bounds);
  const fill = state === 'red' ? '#c73a35' : '#4f9b59';
  return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="24" fill="${fill}" stroke="#3c3c3c" stroke-width="2"/>`;
}

function lightPanel(scene, frame, bundle) {
  const lights = (scene.lights || []).map(light => {
    const value = frame?.lights?.[light.id] ?? frame?.state?.lights?.[light.id];
    const state = typeof value === 'string' ? value : value?.state;
    if (!state) return '';
    const ownerId = String(light.id || '').replace(/^light_/, '');
    const owner = (bundle?.agents || []).find(agent => agent.id === ownerId);
    const color = state === 'red' ? '#c73a35' : '#4f9b59';
    return `<span class="signal"><i style="background:${color}"></i>${esc(owner ? agentLabel(owner) : light.id)}</span>`;
  }).filter(Boolean);
  return lights.length ? `<g class="signal-panel"><foreignObject x="64" y="8" width="872" height="48"><div xmlns="http://www.w3.org/1999/xhtml">${lights.join('')}</div></foreignObject></g>` : '';
}

function obstacleArrow(bundle, frame, obstacle, position, bounds) {
  const previous = latestAt(bundle.frames, Math.max(0, Number(frame.t) - .3))?.state?.obstacles?.[obstacle.id];
  if (!previous) return '';
  const dx = position[0] - previous[0];
  const dy = position[1] - previous[1];
  const length = Math.hypot(dx, dy);
  if (length <= 1e-4) return '';
  const radius = Number(obstacle.radius) || .12;
  const [ax, ay] = point(position[0] + dx / length * (radius + .02), position[1] + dy / length * (radius + .02), bounds);
  const [tx, ty] = point(position[0] + dx / length * (radius + .35), position[1] + dy / length * (radius + .35), bounds);
  return `<path d="M${ax.toFixed(2)} ${ay.toFixed(2)} L${tx.toFixed(2)} ${ty.toFixed(2)}" fill="none" stroke="#37373e" stroke-width="2" marker-end="url(#motion-arrow)"/>`;
}

function observationAnnotations(observation, bounds) {
  const waypoint = observation?.payload?.scenario?.peer_waypoint;
  if (!waypoint?.center) return '';
  const expiry = number(waypoint.expires_in_s);
  const text = expiry == null ? 'Peer waypoint' : `Peer waypoint · ${expiry.toFixed(1)} s`;
  const [x, y] = point(waypoint.center[0], waypoint.center[1], bounds);
  return `${circle(waypoint.center, waypoint.radius || .2, bounds, 'knowledge-waypoint')}${label(x - 26, y - 28, text, 'knowledge-label')}`;
}

function addStyles() {
  return `<style>
    .map-label { font: 400 18px Arial,sans-serif; fill: #333; }
    .robot-label { font: 400 20px Arial,sans-serif; fill: #111; }
    .wall { fill: #3c3c3c; stroke: #3c3c3c; stroke-width: 1; }
    .goal { fill: none; stroke: #1f77b4; stroke-width: 3; }
    .marker { fill: none; stroke-width: 3; stroke-dasharray: 8 6; }
    .knowledge-waypoint { fill: none; stroke: #666; stroke-width: 3; stroke-dasharray: 5 5; }
    .knowledge-label { font: 400 15px Arial,sans-serif; fill: #555; }
    .obstacle { fill: #787882; stroke: none; }
    .arena-border { fill: #fff; stroke: #3c3c3c; stroke-width: 3; }
    .unknown-title { font: 500 28px Arial,sans-serif; fill: #333; }
    .unknown-body { font: 400 18px Arial,sans-serif; fill: #555; }
    .signal-panel div { display: flex; gap: 28px; align-items: center; color: #333; font: 400 22px Arial,sans-serif; }
    .signal { display: inline-flex; align-items: center; gap: 10px; }
    .signal i { width: 36px; height: 36px; flex: 0 0 36px; border: 2px solid #3c3c3c; border-radius: 50%; }
  </style>`;
}

export function renderScene(svgElement, bundle, t, options = {}) {
  if (!svgElement) return;
  const view = options.view || 'world';
  const showTrails = options.trails === true;
  const showArrows = options.arrows === true;
  const state = stateAt(bundle, t);
  const scene = bundle?.scene || {};
  const world = view === 'world';
  const observation = world ? null : state.observations[view];
  const observed = world ? null : sceneFromObservation(observation, scene);
  const bounds = scene.bounds || [-1.8, 1.8, -1.4, 1.4];
  const hasMap = world || (observed?.bounds && observed?.walls?.length);
  let output = `${addStyles()}<rect width="1000" height="740" fill="#fff"/>`;

  if (!world && !observation) {
    output += `<g text-anchor="middle">${label(500, 332, 'Observation not yet recorded', 'unknown-title')}${label(500, 370, 'The agent view begins with its first logged observation.', 'unknown-body')}</g>`;
  } else if (!hasMap) {
    output += `<g text-anchor="middle"><text x="500" y="354" font-family="Arial,sans-serif" font-size="60" fill="#777">?</text>${label(500, 462, 'No visual map or localization', 'unknown-title')}${label(500, 504, 'This logged observation contains no pose, map, goal, or obstacle positions.', 'unknown-body')}</g>`;
  } else {
    const sceneView = world ? scene : observed;
    const [left, top] = point(bounds[0], bounds[3], bounds);
    const [right, bottom] = point(bounds[1], bounds[2], bounds);
    output += `<defs><marker id="motion-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7 Z" fill="#37373e"/></marker></defs>`;
    output += `<rect x="${left.toFixed(2)}" y="${top.toFixed(2)}" width="${(right - left).toFixed(2)}" height="${(bottom - top).toFixed(2)}" class="arena-border"/>`;
    for (const zone of sceneView.zones || []) {
      if (!zone.center) continue;
      const owner = bundle.agents.find(agent => agent.id === zone.agent_id);
      const color = owner ? agentColor(bundle, owner) : '#1f77b4';
      output += circle(zone.center, zone.radius || .2, bounds, 'goal', `style="stroke:${color}"`);
    }
    for (const wall of sceneView.walls || []) output += shapePoly(wall.vertices, bounds, 'wall');
    if (world) {
      for (const marker of currentMarkers(state.frame)) output += markerCircle(marker, bounds, bundle);
      for (const light of scene.lights || []) output += lightGlyph(light, state.frame, bounds);
      output += lightPanel(scene, state.frame, bundle);
    }
    for (const obstacle of world ? scene.obstacles || [] : observed.obstacles || []) {
      const position = world ? state.frame?.state?.obstacles?.[obstacle.id] : obstacle.position || obstacle.center;
      if (!position) continue;
      output += circle(position, obstacle.radius || .12, bounds, 'obstacle');
      if (world && showArrows) output += obstacleArrow(bundle, state.frame, obstacle, position, bounds);
    }
    if (world && state.frame) {
      if (showTrails) for (const agent of bundle?.agents || []) output += traceTrail(bundle, agent, state.t, bounds);
      for (const agent of bundle?.agents || []) output += robot(bundle, agent, state.frame.state?.agents?.[agent.id], scene.robots?.[agent.id], bounds, agentLabel(agent));
    } else if (!world && observed) {
      const own = bundle?.agents?.find(agent => agent.id === view) || { id: view };
      output += robot(bundle, own, observed.agents[view], scene.robots?.[view], bounds, agentLabel(own));
      for (const peer of observed.peers) {
        const agent = bundle?.agents?.find(item => item.id === peer.agent_id) || { id: peer.agent_id };
        output += robot(bundle, agent, peer.pose, scene.robots?.[peer.agent_id], bounds, agentLabel(agent));
      }
      output += observationAnnotations(observation, bounds);
    }
  }
  svgElement.innerHTML = output;
  svgElement.setAttribute('aria-label', world ? `Recorded world state at ${state.t.toFixed(1)} seconds` : `Information available to ${view} at ${state.t.toFixed(1)} seconds`);
}

if (typeof window !== 'undefined') window.PCaPReplay = { stateAt, renderScene };
