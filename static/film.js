import { stateAt } from './replay.js';
import { renderFilmScene } from './film-scene.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const robotName = id => id === 'agent_0' ? 'Robot 1' : 'Robot 2';
const color = id => id === 'agent_0' ? '#1f77b4' : '#ff7f0e';
const cards = new Set(['title', 'problem', 'solution', 'episode_intro', 'closing']);
const params = new URLSearchParams(location.search);
let episode, story, timeline;

function sourceTime(chapter, t) {
  const u = Math.max(0, Math.min(1, (t - chapter.start) / (chapter.end - chapter.start)));
  return chapter.sourceStart + u * (chapter.sourceEnd - chapter.sourceStart);
}

function robotState(agent, t, focus) {
  const state = stateAt(episode, t);
  const d = state.activeDeployments[agent.id];
  const call = episode.calls.find(c => c.agent === agent.id && c.start <= t && (c.end > t || c.inFlight && c.end === t));
  const status = t >= episode.duration ? 'Episode ended' : call ? `In flight · ${(t-call.start).toFixed(1)} s` : 'Idle';
  return `<span class="llm-state ${focus.includes('llm') ? 'focus-text' : ''}">LLM <small class="detail">${status}</small></span><span class="policy-state ${focus.includes('policy') ? 'focus-text' : ''}">${d ? `Policy v${d.version}` : 'No policy yet'}</span>`;
}

function makeTimeline() {
  const excerpts = new Map(story.languageExcerpts.map(e => [e.eventId,e]));
  const rows = [];
  for (const e of episode.events) {
    if (e.channel === 'language' && excerpts.has(e.id)) {
      const phrase = excerpts.get(e.id).text;
      const at = e.text.indexOf(phrase);
      const before = at > 0 ? '[…] ' : '';
      const after = at + phrase.length < e.text.length ? ' […]' : '';
      rows.push({ ...e, category:'language', label:'Message · excerpt', body:`“${before}${phrase}${after}”` });
    } else if (e.kind === 'code_turn_executed') {
      rows.push({ ...e, category:'write', label:'Code', body:`${e.payload.file} ${e.payload.action === 'edit' ? 'edited' : 'written'}` });
    } else if (e.kind === 'policy_worker_spawned') {
      rows.push({ ...e, category:'deployment', label:'Deployment', body:e.version === 1 ? 'Starter policy v1 activated' : `Policy v${e.version} deployed` });
    }
  }
  return rows.sort((a,b) => a.t-b.t);
}

function eventStream(agent, t, focus, language = false) {
  const available = timeline.filter(e => e.agent === agent.id && e.t <= t && (e.category === 'language') === language);
  const entering = available.length && t - available.at(-1).t < .6;
  const limit = language ? 3 : 4;
  const events = available.slice(-(limit + (entering ? 1 : 0))).reverse();
  if (!events.length) return `<p class="empty">${language ? 'No language messages yet.' : 'No code or deployments yet.'}</p>`;
  return `<div class="event-list">` + events.map(e => `<div class="event ${focus.includes(e.category) ? 'highlight' : ''}" data-id="${e.id}" data-agent="${e.agent}" data-time="${e.t}" data-kind="${e.category}" style="--agent-color:${color(e.agent)}"><div class="event-meta">${clock(e.t)}</div><div class="event-body">${escape(e.body)}</div></div>`).join('') + '</div>';
}

function fillEventStream(feed, html, t) {
  feed.innerHTML = html;
  const first = feed.querySelector('.event');
  if (first) {
    const progress = Math.min(1, Math.max(0, (t - Number(first.dataset.time)) / .6));
    feed.firstElementChild.style.transform = `translateY(${-(first.offsetHeight + 10) * (1-progress)**3}px)`;
    feed.dataset.entering = String(progress < 1);
  } else feed.dataset.entering = 'false';
}

function fitHeadline(text) {
  const headline = $('headline');
  headline.textContent = text;
  let size = 60;
  headline.style.fontSize = `${size}px`;
  // Keep author text intact, fitting up to three lines below the central views.
  while (headline.scrollHeight > 196 && size > 42) {
    headline.style.fontSize = `${--size}px`;
  }
}

function protocolStream(a, t) {
  const e = episode.events.filter(e => e.agent === a.id && e.channel === 'policy' && e.kind === 'message_sent' && e.t <= t).at(-1);
  const target = e?.payload?.target ?? e?.payload?.center;
  const detail = e ? `${e.payload.type || 'message'} · ${clock(e.t)}` : 'No policy message yet';
  return `<div class="packet" data-agent="${a.id}" data-time="${e?.t ?? ''}" style="--agent-color:${color(a.id)}"><pre class="packet-data">${escape(detail)}\ntarget: ${e ? escape(JSON.stringify(target ?? null)) : '—'}</pre></div>`;
}

async function seekCamera(t) {
  const camera = $('camera');
  if (params.has('composite')) return;
  if (Math.abs(camera.currentTime - t) < .012 && camera.readyState >= 2) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(Error('Camera seek timed out')); }, 15000);
    const cleanup = () => { clearTimeout(timeout); camera.removeEventListener('seeked', done); camera.removeEventListener('error', fail); };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(Error('Camera footage unavailable')); };
    camera.addEventListener('seeked', done, { once: true });
    camera.addEventListener('error', fail, { once: true });
    camera.currentTime = t;
  });
}

async function renderAt(time) {
  const t = Math.max(0, Math.min(story.duration, Number(time) || 0));
  const c = story.chapters.find(c => t >= c.start && t < c.end) || story.chapters.at(-1);
  const ep = sourceTime(c,t), cameraTime = ep+story.camera.offset, card = cards.has(c.mode), focus = c.focus || [];
  $('film').dataset.mode = c.mode;
  $('card').hidden = !card;
  $('episode-stage').hidden = card;
  if (card) {
    $('card-label').textContent = {problem:'The problem',solution:'Our solution',closing:'Protocols with Code-as-Policy'}[c.mode] || '';
    $('card-title').textContent = c.headline;
    $('card-body').textContent = c.subhead;
    $('card-footer').textContent = c.caption;
    $('solution-figure').hidden = c.mode !== 'solution';
    if (c.mode === 'solution') await $('solution-figure').decode();
  } else {
    fitHeadline(c.headline);
    episode.agents.forEach((agent, i) => {
      $(`robot-${i}`).innerHTML = robotState(agent,ep,focus);
      fillEventStream($(`message-stream-${i}`), eventStream(agent,ep,focus,true), ep);
      fillEventStream($(`event-stream-${i}`), eventStream(agent,ep,focus), ep);
      $(`protocol-stream-${i}`).innerHTML = protocolStream(agent,ep);
      $(`protocol-panel-${i}`).classList.toggle('focus-pane',focus.includes('protocol'));
    });
    $('episode-time').textContent = `Episode ${clock(ep)}`;
    $('transport-label').textContent = `${story.playback.rate}× playback`;
    for (const [id, key] of [['camera-panel','camera'],['reconstruction','render']]) $(id).classList.toggle('focus-pane',focus.includes(key));
    renderFilmScene($('scene'),episode,ep);
    const counts = stateAt(episode,ep).frame?.scalars?.waypoints_reached || [0,0];
    $('goal-counts').innerHTML = counts.map((n,i) => `<span style="color:${color('agent_'+i)}">Robot ${i+1}: ${n}/8</span>`).join('');
    await seekCamera(cameraTime);
  }
  window.filmState = {filmTime:t,episodeTime:ep,cameraTime,mode:c.mode,focus};
  await document.fonts.ready;
}

async function boot() {
  try {
    story = await fetch('static/data/story.json').then(r => { if (!r.ok) throw Error('Story unavailable'); return r.json(); });
    episode = await fetch(story.episode.url).then(r => { if (!r.ok) throw Error('Episode unavailable'); return r.json(); });
    if (story.episode.id !== episode.id) throw Error('Story references a different episode');
    for (const e of story.languageExcerpts) {
      if (!episode.events.some(row => row.id === e.eventId && row.agent === e.agent && row.text.includes(e.text))) throw Error('Message excerpt is not supported by the trace');
    }
    timeline = makeTimeline();
    const resize = () => $('film').style.transform = `scale(${Math.min(innerWidth/1920,innerHeight/1080)})`;
    addEventListener('resize',resize); resize();
    document.body.classList.toggle('capture',params.has('capture'));
    if (!params.has('composite')) {
      $('camera').src = story.camera.url;
      await new Promise((resolve,reject) => {
        $('camera').addEventListener('loadeddata',resolve,{once:true});
        $('camera').addEventListener('error',() => reject(Error('Camera footage unavailable')),{once:true});
      });
    }
    window.renderAt = renderAt;
    await renderAt(0);
    window.filmReady = true;
    if (!params.has('capture')) {
      const start = performance.now();
      const tick = async () => {
        const t = Math.min(story.duration,(performance.now()-start)/1000);
        await renderAt(t);
        if (t < story.duration) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  } catch (error) {
    window.filmError = error.message;
    $('card-title').textContent = `Film unavailable: ${error.message}`;
  }
}
boot();
