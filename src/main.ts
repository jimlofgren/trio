import { AudioEngine } from './audio';
import { CableLayer } from './cables';
import { buildControls, type ControlPanel } from './knobs';
import { createTransport, type Transport } from './net';
import {
  BASS_NOTES, CONTROLS, DEFAULT_PARAMS, DRUM_NAMES, KEY_COUNT, KEY_LOW, SLOTS, STEPS,
  bassLabel, defaultState, exportPattern, followOffset, isBlackKey, noteLabel, noteName, stepMs,
  type Message, type Player, type Slot, type State,
} from './state';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const statusEl = $<HTMLDivElement>('#status');
let bpmInput: HTMLInputElement;

const params = new URLSearchParams(location.search);
const ROOM = (params.get('room') ?? 'jam').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'jam';
const EDIT_ALL = params.has('all');

function canEdit(slot: Slot): boolean {
  return EDIT_ALL || me.slot === slot;
}

let net: Transport | null = null;
let engine: AudioEngine;
let state: State;
let me: Player;
let players: Player[] = [];
let synced = false;

const BRAND: Record<Slot, { title: string; sub: string }> = {
  synth: { title: 'Chord Synth', sub: 'polyphonic · dub echo' },
  drums: { title: 'Drum Machine', sub: 'rhythm composer · tempo' },
  bass: { title: 'Bass Synth', sub: 'monophonic · glide' },
};
const cells: Record<Slot, HTMLElement[][]> = { synth: [], drums: [], bass: [] };
const controls: Partial<Record<Slot, ControlPanel>> = {};
const displays: Partial<Record<Slot, HTMLElement>> = {};
const keys: HTMLElement[] = [];
const cables = new CableLayer($<HTMLDivElement>('#app'));

void enter(localStorage.getItem('trio-name') ?? '', ROOM);

function serverNow(): number {
  return net ? net.serverNow() : Date.now();
}

async function enter(name: string, room: string): Promise<void> {
  me = { id: '', name, slot: null, since: 0 };
  engine = new AudioEngine(serverNow, highlightStep);
  engine.onStateChange(renderStatus);
  for (const ev of ['pointerdown', 'keydown'] as const) document.addEventListener(ev, () => void engine.resume());
  state = defaultState(Date.now());
  buildPanels();
  cables.add('kick-out', 'synth-duck', () => state.params.synth.duck, '#e5392c');
  cables.add('kick-out', 'bass-duck', () => state.params.bass.duck, '#e5392c');
  cables.add('bass-pitch', 'synth-pitch', () => state.params.synth.follow, '#3fb6e8');
  applyState(state);
  engine.start();
  requestAnimationFrame(playheadLoop);
  renderStatus();

  const transport = await createTransport(room);
  const localOffset = transport.serverNow() - Date.now();
  net = transport;
  me = { ...me, id: net.id };
  net.onPlayers(onPlayers);
  net.onMessage(onMessage);
  await net.setPresence(name, null);
  const others = net.players().filter((p) => p.id !== me.id);
  if (others.length === 0) {
    adoptLocalState(localOffset);
  } else {
    net.send({ t: 'hello' });
    window.setTimeout(() => { if (!synced) adoptLocalState(localOffset); }, 2000);
  }
  renderStatus();
}

function adoptLocalState(offset: number): void {
  synced = true;
  state.transport = { ...state.transport, startAt: state.transport.startAt + offset };
  engine.setState(state);
  net?.send({ t: 'transport', transport: state.transport });
}

function applyState(next: State): void {
  state = next;
  state.params ??= structuredClone(DEFAULT_PARAMS);
  for (const slot of SLOTS) state.params[slot] = { ...DEFAULT_PARAMS[slot], ...state.params[slot] };
  engine.setState(state);
  bpmInput.value = String(state.transport.bpm);
  for (const slot of SLOTS) {
    paintGrid(slot);
    controls[slot]?.update(state.params[slot]);
  }
  paintKeys();
}

function onMessage(msg: Message): void {
  switch (msg.t) {
    case 'hello':
      if (synced) net?.send({ t: 'snapshot', state });
      return;
    case 'snapshot':
      if (!synced) {
        synced = true;
        applyState(msg.state);
      }
      return;
  }
  switch (msg.t) {
    case 'drums': state.drums = msg.grid; paintGrid('drums'); break;
    case 'chords': state.chordNotes = msg.notes; state.chordSteps = msg.steps; paintGrid('synth'); paintKeys(); break;
    case 'bass': state.bass = msg.steps; paintGrid('bass'); break;
    case 'params':
      state.params[msg.slot] = { ...DEFAULT_PARAMS[msg.slot], ...msg.params };
      controls[msg.slot]?.update(state.params[msg.slot]);
      break;
    case 'transport':
      state.transport = msg.transport;
      bpmInput.value = String(msg.transport.bpm);
      if (!msg.transport.playing) clearHead();
      break;
  }
  engine.setState(state);
}

function onPlayers(list: Player[]): void {
  players = list;
  const mine = list.find((p) => p.id === me.id);
  if (mine) me = mine;
  for (const slot of SLOTS) renderHead(slot);
  renderStatus();
  void autoAssign();
}

function holder(slot: Slot): Player | undefined {
  return players
    .filter((p) => p.slot === slot)
    .sort((a, b) => a.since - b.since || a.id.localeCompare(b.id))[0];
}

function waitingLine(): Player[] {
  return players.filter((p) => !p.slot).sort((a, b) => a.since - b.since || a.id.localeCompare(b.id));
}

let assigning = false;
async function autoAssign(): Promise<void> {
  if (assigning) return;
  const keepsMine = me.slot && holder(me.slot)?.id === me.id;
  if (keepsMine) return;
  if (!me.slot && waitingLine()[0]?.id !== me.id) return;
  const taken = new Set(players.filter((p) => p.id !== me.id).map((p) => p.slot));
  const preferred = localStorage.getItem('trio-slot') as Slot | null;
  const free = (preferred && SLOTS.includes(preferred) && !taken.has(preferred) ? preferred : null)
    ?? SLOTS.find((slot) => !taken.has(slot))
    ?? null;
  if (free === me.slot || !net) return;
  assigning = true;
  me = { ...me, slot: free };
  if (free) localStorage.setItem('trio-slot', free);
  try {
    await net.setPresence(me.name, me.slot);
  } finally {
    assigning = false;
  }
  if (!net.online) onPlayers([me]);
}

function displayName(p: Player): string {
  return p.name.trim() || 'player';
}

async function rename(value: string): Promise<void> {
  const name = value.trim().slice(0, 16);
  if (name === me.name) return;
  me = { ...me, name };
  localStorage.setItem('trio-name', name);
  if (!net) return;
  await net.setPresence(me.name, me.slot);
  if (!net.online) onPlayers([me]);
}

const paramTimers: Partial<Record<Slot, number>> = {};
function onParam(slot: Slot, key: string, value: number, final: boolean): void {
  if (!canEdit(slot)) return;
  state.params[slot][key] = value;
  engine.setState(state);
  controls[slot]?.update(state.params[slot]);
  const flush = () => {
    paramTimers[slot] = undefined;
    net?.send({ t: 'params', slot, params: state.params[slot] });
  };
  if (final) {
    if (paramTimers[slot]) window.clearTimeout(paramTimers[slot]);
    flush();
  } else if (!paramTimers[slot]) {
    paramTimers[slot] = window.setTimeout(flush, 80);
  }
}

function buildPanels(): void {
  for (const slot of SLOTS) {
    const panel = $<HTMLElement>(`.panel.${slot}`);
    panel.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'panel-head';
    panel.appendChild(head);

    const panelControls = buildControls(CONTROLS[slot], DEFAULT_PARAMS[slot], (k, v, f) => onParam(slot, k, v, f));
    controls[slot] = panelControls;
    if (slot === 'drums') panelControls.root.prepend(buildTempo());
    panel.appendChild(panelControls.root);

    if (slot === 'synth') panel.appendChild(buildKeyboard());

    const grid = document.createElement('div');
    grid.className = 'grid';
    panel.appendChild(grid);
    const rows = slot === 'drums' ? DRUM_NAMES.length : slot === 'synth' ? 1 : BASS_NOTES;
    cells[slot] = [];
    for (let r = 0; r < rows; r++) {
      const row = slot === 'bass' ? rows - 1 - r : r;
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = slot === 'drums' ? DRUM_NAMES[row] : slot === 'synth' ? 'HIT' : bassLabel(row);
      grid.appendChild(label);
      cells[slot][row] = [];
      for (let step = 0; step < STEPS; step++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = `cell q${Math.floor(step / 4)}` + (step % 4 === 0 ? ' beat' : '');
        const led = document.createElement('i');
        led.className = 'led';
        cell.appendChild(led);
        cell.addEventListener('click', () => toggle(slot, row, step));
        grid.appendChild(cell);
        cells[slot][row][step] = cell;
      }
    }
    renderHead(slot);
  }
}

function buildKeyboard(): HTMLElement {
  const board = document.createElement('div');
  board.className = 'keys';
  const whites = document.createElement('div');
  whites.className = 'whites';
  board.appendChild(whites);
  const whiteCount = Array.from({ length: KEY_COUNT }, (_, i) => KEY_LOW + i).filter((m) => !isBlackKey(m)).length;
  let whitesBefore = 0;
  for (let i = 0; i < KEY_COUNT; i++) {
    const midi = KEY_LOW + i;
    const key = document.createElement('button');
    key.type = 'button';
    key.addEventListener('click', () => toggleNote(midi));
    keys[i] = key;
    if (isBlackKey(midi)) {
      key.className = 'key black';
      key.style.left = `calc(${(whitesBefore / whiteCount) * 100}% - 1.8%)`;
      board.appendChild(key);
    } else {
      key.className = 'key white';
      key.textContent = noteLabel(midi);
      whites.appendChild(key);
      whitesBefore++;
    }
  }
  return board;
}

function toggleNote(midi: number): void {
  if (!canEdit('synth')) return;
  const notes = new Set(state.chordNotes);
  if (notes.has(midi)) notes.delete(midi);
  else notes.add(midi);
  state.chordNotes = [...notes].sort((a, b) => a - b);
  net?.send({ t: 'chords', notes: state.chordNotes, steps: state.chordSteps });
  engine.setState(state);
  paintKeys();
}

function paintKeys(): void {
  const active = new Set(state.chordNotes);
  keys.forEach((key, i) => key.classList.toggle('on', active.has(KEY_LOW + i)));
  const display = displays.synth;
  if (display) display.textContent = state.chordNotes.length ? state.chordNotes.map(noteName).join(' ') : '--';
}

function buildTempo(): HTMLElement {
  const group = document.createElement('div');
  group.className = 'control-group tempo';
  const title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = 'Tempo';
  const body = document.createElement('div');
  body.className = 'group-body';
  bpmInput = document.createElement('input');
  bpmInput.type = 'number';
  bpmInput.min = '60';
  bpmInput.max = '180';
  bpmInput.step = '1';
  bpmInput.className = 'bpm';
  bpmInput.addEventListener('change', onBpmChange);
  const unit = document.createElement('span');
  unit.textContent = 'bpm';
  body.append(bpmInput, unit);
  group.append(title, body);
  return group;
}

function renderHead(slot: Slot): void {
  const panel = $<HTMLElement>(`.panel.${slot}`);
  const head = panel.querySelector('.panel-head') as HTMLElement;
  const owner = holder(slot);
  const mine = owner?.id === me.id;
  panel.classList.toggle('mine', mine || EDIT_ALL);
  if (slot === 'drums' && bpmInput) bpmInput.disabled = !canEdit('drums');
  head.innerHTML = '';
  const brand = document.createElement('div');
  brand.className = 'brand-block';
  const title = document.createElement('h2');
  title.textContent = BRAND[slot].title;
  const sub = document.createElement('small');
  sub.textContent = BRAND[slot].sub;
  brand.append(title, sub);
  head.appendChild(brand);
  const display = document.createElement('div');
  display.className = 'display';
  display.textContent = displays[slot]?.textContent ?? '--';
  displays[slot] = display;
  head.appendChild(display);
  if (slot === 'synth') paintKeys();
  const who = document.createElement('span');
  who.className = 'who';
  if (mine) {
    const input = document.createElement('input');
    input.className = 'name-input';
    input.placeholder = 'your name';
    input.maxLength = 16;
    input.autocomplete = 'off';
    input.value = me.name;
    input.addEventListener('change', () => void rename(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    who.appendChild(input);
  } else {
    who.innerHTML = owner ? `<b>${escapeHtml(displayName(owner))}</b>` : 'open spot';
  }
  head.appendChild(who);
}

function renderStatus(): void {
  const sound = engine.running ? '' : ' · click anywhere to enable sound';
  if (!net) {
    statusEl.textContent = `connecting…${sound}`;
    return;
  }
  const names = players.map((p) => displayName(p) + (p.slot ? '' : ' (waiting)')).join(', ');
  const place = waitingLine().findIndex((p) => p.id === me.id) + 1;
  const role = me.slot
    ? `you play ${BRAND[me.slot].title.toLowerCase()}`
    : place <= 1 ? 'band is full · you get the next open spot' : `band is full · ${place - 1} ahead of you in line`;
  const link = net.online ? `${role} · ${names}` : `${role} · solo mode`;
  statusEl.textContent = link + sound;
  $<HTMLDivElement>('#waiting').hidden = !!me.slot || EDIT_ALL;
}

function toggle(slot: Slot, row: number, step: number): void {
  if (!canEdit(slot)) return;
  if (slot === 'drums') {
    state.drums[row][step] = !state.drums[row][step];
    net?.send({ t: 'drums', grid: state.drums });
  } else if (slot === 'synth') {
    state.chordSteps[step] = !state.chordSteps[step];
    net?.send({ t: 'chords', notes: state.chordNotes, steps: state.chordSteps });
  } else {
    state.bass[step] = state.bass[step] === row ? -1 : row;
    net?.send({ t: 'bass', steps: state.bass });
  }
  engine.setState(state);
  paintGrid(slot);
}

function paintGrid(slot: Slot): void {
  const rows = cells[slot];
  for (let r = 0; r < rows.length; r++) {
    for (let s = 0; s < STEPS; s++) {
      const on = slot === 'drums' ? state.drums[r][s] : slot === 'synth' ? state.chordSteps[s] : state.bass[s] === r;
      rows[r][s].classList.toggle('on', on);
    }
  }
}

let lastHead = -1;
function highlightStep(step: number): void {
  if (step === lastHead) return;
  for (const slot of SLOTS) {
    for (const row of cells[slot]) {
      if (lastHead >= 0) row[lastHead].classList.remove('head');
      row[step].classList.add('head');
    }
  }
  lastHead = step;
  updateDisplays(step);
  if (state.drums[0][step]) cables.pulse('kick-out');
  if (state.bass[step] >= 0) cables.pulse('bass-pitch');
}

function updateDisplays(step: number): void {
  const hit = state.chordSteps[step];
  displays.synth?.classList.toggle('lit', hit);
  if (hit && displays.synth) {
    const offset = followOffset(state, step);
    displays.synth.textContent = state.chordNotes.map((n) => noteName(n + offset)).join(' ') || '--';
  }
  displays.drums!.textContent = String(step + 1).padStart(2, '0');
  const note = state.bass[step];
  if (note >= 0) displays.bass!.textContent = bassLabel(note);
}

function clearHead(): void {
  if (lastHead < 0) return;
  for (const slot of SLOTS) for (const row of cells[slot]) row[lastHead].classList.remove('head');
  lastHead = -1;
}

function playheadLoop(): void {
  if (!state.transport.playing) clearHead();
  cables.update();
  requestAnimationFrame(playheadLoop);
}

function setTransport(patch: Partial<State['transport']>): void {
  state.transport = { ...state.transport, ...patch };
  engine.setState(state);
  if (!state.transport.playing) clearHead();
  net?.send({ t: 'transport', transport: state.transport });
}

$<HTMLButtonElement>('#play').addEventListener('click', () => {
  void engine.resume();
  if (!me.slot && !EDIT_ALL) return;
  setTransport({ playing: true, startAt: serverNow() + 100 });
});

$<HTMLButtonElement>('#stop').addEventListener('click', () => {
  if (!me.slot && !EDIT_ALL) return;
  setTransport({ playing: false });
});

$<HTMLButtonElement>('#copy').hidden = !EDIT_ALL;
$<HTMLButtonElement>('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(exportPattern(state));
  statusEl.textContent = 'pattern copied · paste it into src/default-pattern.json';
  window.setTimeout(renderStatus, 4000);
});

function onBpmChange(): void {
  if (!canEdit('drums')) return;
  const bpm = Math.min(180, Math.max(60, Number(bpmInput.value) || 110));
  bpmInput.value = String(bpm);
  const now = serverNow();
  const elapsedSteps = Math.max(0, (now - state.transport.startAt) / stepMs(state.transport.bpm));
  setTransport({ bpm, startAt: now - elapsedSteps * stepMs(bpm) });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
