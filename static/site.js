import { stateAt, renderScene } from './replay.js';

const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const formatTime = value => {
  const t = Math.max(0, Number(value) || 0);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor(t % 1 * 10)}`;
};
const titleCase = value => String(value || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const payloadText = event => typeof event.payload === 'string'
  ? event.payload
  : event.payload != null ? JSON.stringify(event.payload, null, 2) : event.text || '';

let catalog = null;
let bundle = null;
let selectedEpisode = null;
let now = 0;
let playing = false;
let speed = 1;
let animation = null;
let previousTick = null;
let selectionRequest = 0;
let selectedPanel = 'timeline';
let sourceMode = 'source';
let currentSource = null;
let eventRows = [];
let messageRows = [];
const cachedEpisodes = new Map();
const packetRows = new Map();
const lastPackets = new Map();

function roleLabel(agent) {
  const sameRole = bundle.agents.filter(peer => peer.role === agent.role).length > 1;
  return sameRole ? `Robot ${bundle.agents.indexOf(agent) + 1}` : agent.role;
}

function agentLabel(id) {
  const agent = bundle.agents.find(row => row.id === id);
  return agent ? roleLabel(agent) : 'Team';
}

function deploymentAt(agent, t) {
  return bundle.deployments.filter(row => row.agent === agent && row.t <= t).at(-1);
}

function latestAt(rows, time) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (Number(rows[middle].t) <= time) low = middle + 1;
    else high = middle;
  }
  return rows[low - 1] || null;
}

function syncRows(rows, container, follow) {
  let latest = null;
  for (const { event, element } of rows) {
    element.hidden = event.t > now;
    element.classList.remove('is-current');
    if (!element.hidden) latest = element;
  }
  const changed = container.dataset.latest !== (latest?.dataset.id || '');
  container.dataset.latest = latest?.dataset.id || '';
  latest?.classList.add('is-current');
  if (follow && changed && latest) {
    const outer = container.getBoundingClientRect();
    container.scrollTop += latest.getBoundingClientRect().top - outer.top - container.clientHeight * .4;
  }
  container.querySelector('.panel-empty').hidden = Boolean(latest);
}

function syncPackets() {
  for (const agent of bundle.agents) {
    const packet = latestAt(packetRows.get(agent.id) || [], now);
    if (lastPackets.get(agent.id) === (packet?.id || null)) continue;
    lastPackets.set(agent.id, packet?.id || null);
    const panel = $('packet-feed').querySelector(`[data-agent="${agent.id}"]`);
    const deployed = packet ? deploymentAt(agent.id, packet.t) : null;
    panel.querySelector('.packet-meta').textContent = packet
      ? `Sent ${formatTime(packet.t)} · ${deployed ? 'policy v' + deployed.version : 'policy version unavailable'}`
      : 'No messages sent yet';
    panel.querySelector('pre').textContent = packet ? payloadText(packet) : '—';
    panel.dataset.t = packet ? String(packet.t) : '';
  }
}

function syncSource() {
  const agent = $('code-agent-select').value;
  const deployments = bundle.deployments.filter(row => row.agent === agent && row.t <= now);
  const options = deployments.map(row =>
    `<option value="${escapeHTML(row.id)}">v${escapeHTML(row.version)} · ${formatTime(row.t)}</option>`,
  ).join('');
  const select = $('code-version-select');
  if (select.innerHTML !== options) select.innerHTML = options;
  select.disabled = !deployments.length;
  const deployed = deployments.at(-1);
  select.value = deployed?.id || '';
  const source = bundle.sources.find(row => row.id === deployed?.sourceId);
  const identity = `${agent}:${deployed?.id || ''}`;
  if (currentSource !== identity) {
    currentSource = identity;
    sourceMode = 'source';
    $('source-code').scrollTop = 0;
  }
  $('source-label').textContent = deployed ? `Deployed ${formatTime(deployed.t)} · ${deployed.hash}` : '';
  $('source-toggle').disabled = !source?.diff;
  $('source-toggle').textContent = sourceMode === 'source' ? 'Changes' : 'Source';
  const text = !deployed ? 'No policy deployed yet.'
    : !source ? 'Verified source is unavailable for this deployment.'
      : sourceMode === 'diff' ? source.diff : source.source;
  if ($('source-code').textContent !== text) $('source-code').textContent = text;
}

function setTime(value) {
  if (!bundle) return;
  now = Math.max(0, Math.min(bundle.duration, Number(value) || 0));
  $('time-slider').value = String(now);
  $('clock-label').textContent = formatTime(now);
  const replay = stateAt(bundle, now);
  renderScene($('scene-svg'), bundle, now, { view: 'world' });
  for (const agent of bundle.agents) {
    const card = $('agent-status').querySelector(`[data-agent="${agent.id}"]`);
    const deployed = replay.activeDeployments[agent.id];
    // A call censored by the end of recording did not finish at that time.
    const activeCall = bundle.calls.find(call => call.agent === agent.id && call.start <= now
      && (call.end == null || call.end > now || (call.inFlight && call.end === now)));
    card.querySelector('.policy-version').textContent = deployed ? `v${deployed.version}` : 'None';
    card.querySelector('.llm-status').textContent = activeCall
      ? `In flight · ${(now - activeCall.start).toFixed(1)} s` : 'Idle';
  }
  syncRows(eventRows, $('event-list'), selectedPanel === 'timeline');
  syncRows(messageRows, $('message-list'), selectedPanel === 'messages');
  syncPackets();
  syncSource();
}

function setPlaying(value) {
  playing = Boolean(value && bundle);
  $('play-toggle').textContent = playing ? 'Pause' : 'Play';
  $('play-toggle').setAttribute('aria-label', playing ? 'Pause episode' : 'Play episode');
  if (animation) cancelAnimationFrame(animation);
  previousTick = null;
  if (playing) {
    if (now >= bundle.duration) setTime(0);
    animation = requestAnimationFrame(tick);
  }
}

function tick(timestamp) {
  if (!playing) return;
  if (previousTick != null) setTime(now + (timestamp - previousTick) / 1000 * speed);
  previousTick = timestamp;
  if (now >= bundle.duration) setPlaying(false);
  else animation = requestAnimationFrame(tick);
}

function setPanel(panel) {
  selectedPanel = panel;
  for (const button of document.querySelectorAll('.evidence-tab')) {
    const active = button.dataset.panel === panel;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    $(button.getAttribute('aria-controls')).hidden = !active;
  }
  if (bundle) setTime(now);
}

function eventTitle(event) {
  const titles = {
    message_sent: 'Language message sent',
    policy_worker_spawned: event.reason === 'initial' ? 'Starter policy active' : 'Policy deployed',
    llm_query_started: 'LLM call started',
    llm_response_received: 'LLM response received',
    episode_status: 'Episode status',
    policy_worker_restarting: 'Policy restarting',
    code_edit: 'Policy edited',
  };
  return titles[event.kind] || titleCase(event.kind);
}

function makeRows(events, container, messages = false) {
  container.innerHTML = '';
  const empty = document.createElement('p');
  empty.className = 'panel-empty';
  empty.textContent = messages ? 'Language messages will appear here.' : 'Events will appear here.';
  container.append(empty);
  return events.map(event => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = messages ? 'message-row' : 'event-row';
    element.dataset.id = event.id;
    element.dataset.t = event.t;
    element.dataset.kind = event.kind;
    if (event.agent) element.dataset.agent = event.agent;
    const heading = messages
      ? `${agentLabel(event.agent)} → ${agentLabel(event.recipient)}`
      : eventTitle(event);
    let detail = '';
    if (messages) detail = payloadText(event);
    else if (event.kind === 'policy_worker_spawned') detail = `Policy v${event.version}`;
    else if (event.kind === 'episode_status') detail = event.text || '';
    element.innerHTML = `<span class="row-heading"><strong>${escapeHTML(heading)}</strong><time>${formatTime(event.t)}</time></span>
      ${messages || !event.agent ? '' : `<span class="row-agent">${escapeHTML(agentLabel(event.agent))}</span>`}
      ${detail ? `<p>${escapeHTML(detail)}</p>` : ''}`;
    element.addEventListener('click', () => {
      setPlaying(false);
      if (event.sourceId) {
        $('code-agent-select').value = event.agent;
        setPanel('code');
      }
      setTime(event.t);
    });
    container.append(element);
    return { event, element };
  });
}

function prepareEpisode() {
  $('agent-status').innerHTML = bundle.agents.map(agent => `
    <section data-agent="${escapeHTML(agent.id)}">
      <strong>${escapeHTML(roleLabel(agent))}</strong>
      <span class="model">${escapeHTML(agent.model)}</span>
      <dl>
        <div><dt>Policy version:</dt><dd class="policy-version">None</dd></div>
        <div><dt>LLM status:</dt><dd class="llm-status">Idle</dd></div>
      </dl>
    </section>`).join('');
  $('packet-feed').innerHTML = bundle.agents.map(agent => `
    <section data-agent="${escapeHTML(agent.id)}">
      <strong>${escapeHTML(roleLabel(agent))}</strong><span class="packet-meta"></span>
      <pre tabindex="0"></pre>
    </section>`).join('');
  $('code-agent-select').innerHTML = bundle.agents.map(agent =>
    `<option value="${escapeHTML(agent.id)}">${escapeHTML(roleLabel(agent))}</option>`,
  ).join('');
  lastPackets.clear();
  packetRows.clear();
  for (const agent of bundle.agents) {
    packetRows.set(agent.id, bundle.events.filter(event =>
      event.agent === agent.id && event.channel === 'policy' && event.kind === 'message_sent'));
  }
  const events = bundle.events.filter(event => event.channel !== 'policy'
    && !/error|rejected|failed/i.test(event.kind)
    && !/^(light_|goal_|waypoint_|agent_arrived$)/.test(event.kind));
  eventRows = makeRows(events, $('event-list'));
  messageRows = makeRows(bundle.events.filter(event =>
    event.channel === 'language' && event.kind === 'message_sent'), $('message-list'), true);
  currentSource = null;
  $('event-list').dataset.latest = '';
  $('message-list').dataset.latest = '';
  $('duration-label').textContent = formatTime(bundle.duration);
  $('time-slider').max = bundle.duration;
  $('episode-outcome').textContent = `Successful episode · ${formatTime(bundle.duration)}`;
}

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data.schemaVersion !== 1) throw new Error('Unsupported data version');
  return data;
}

async function selectEpisode(id) {
  const entry = catalog.episodes.find(row => row.id === id);
  if (!entry) throw new Error('Unknown episode');
  const request = ++selectionRequest;
  setPlaying(false);
  bundle = null;
  selectedEpisode = null;
  $('episode-select').value = id;
  $('replay-app').setAttribute('aria-busy', 'true');
  $('play-toggle').disabled = true;
  $('time-slider').disabled = true;
  $('scene-loading').hidden = false;
  $('scene-loading').textContent = 'Loading episode trace…';
  $('episode-outcome').textContent = '';
  for (const name of ['scene-svg', 'agent-status', 'packet-feed', 'event-list', 'message-list', 'source-code', 'source-label', 'code-agent-select', 'code-version-select']) $(name).textContent = '';
  try {
    if (!cachedEpisodes.has(id)) cachedEpisodes.set(id, fetchJSON(entry.url));
    const loaded = await cachedEpisodes.get(id);
    if (request !== selectionRequest) return;
    bundle = loaded;
    selectedEpisode = id;
    prepareEpisode();
    setTime(0);
    $('scene-loading').hidden = true;
    $('play-toggle').disabled = false;
    $('time-slider').disabled = false;
  } catch (error) {
    cachedEpisodes.delete(id);
    if (request !== selectionRequest) return;
    $('scene-loading').textContent = `Episode unavailable: ${error.message}. Select a task to retry.`;
  } finally {
    if (request === selectionRequest) $('replay-app').setAttribute('aria-busy', 'false');
  }
}

$('episode-select').addEventListener('change', event => selectEpisode(event.target.value));
$('play-toggle').addEventListener('click', () => setPlaying(!playing));
$('time-slider').addEventListener('input', event => {
  setPlaying(false);
  setTime(event.target.value);
});
$('speed-select').addEventListener('change', event => { speed = Number(event.target.value); });
$('code-agent-select').addEventListener('change', () => { if (bundle) syncSource(); });
$('code-version-select').addEventListener('change', event => {
  const deployment = bundle?.deployments.find(row => row.id === event.target.value);
  if (deployment) {
    setPlaying(false);
    setTime(deployment.t);
  }
});
$('source-toggle').addEventListener('click', () => {
  sourceMode = sourceMode === 'source' ? 'diff' : 'source';
  if (bundle) syncSource();
});
for (const tab of document.querySelectorAll('.evidence-tab')) {
  tab.addEventListener('click', () => setPanel(tab.dataset.panel));
  tab.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('.evidence-tab')];
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setPanel(tabs[index].dataset.panel);
    tabs[index].focus();
  });
}
$('film-video').addEventListener('error', () => { $('film-unavailable').hidden = false; });
$('film-video').querySelector('source').addEventListener('error', () => { $('film-unavailable').hidden = false; });

window.PCaPSite = {
  get ready() { return Boolean(bundle); },
  get bundle() { return bundle; },
  get catalog() { return catalog; },
  get selectedEpisode() { return selectedEpisode; },
  seek: setTime,
  getTime: () => now,
  selectEpisode,
};

try {
  catalog = await fetchJSON('./static/data/episodes.json');
  $('episode-select').innerHTML = catalog.episodes.map(entry =>
    `<option value="${escapeHTML(entry.id)}">${escapeHTML(entry.label)}</option>`,
  ).join('');
  $('episode-select').disabled = false;
  await selectEpisode(catalog.defaultEpisode || catalog.episodes[0].id);
} catch (error) {
  $('scene-loading').textContent = `Episode catalog unavailable: ${error.message}`;
  $('replay-app').setAttribute('aria-busy', 'false');
}
