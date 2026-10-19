export const STEPS = 16;
export type Slot = 'synth' | 'drums' | 'bass';
export const SLOTS: Slot[] = ['synth', 'drums', 'bass'];

export const DRUM_NAMES = ['BD', 'SD', 'CH', 'OH'] as const;

export const KEY_LOW = 48;
export const KEY_COUNT = 24;
export const BASS_LOW = 36;
export const BASS_NOTES = 13;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(midi: number): string {
  return NOTE_NAMES[midi % 12];
}
export function isBlackKey(midi: number): boolean {
  return NOTE_NAMES[midi % 12].length === 2;
}
export function noteLabel(midi: number): string {
  return noteName(midi) + (Math.floor(midi / 12) - 1);
}
export function bassLabel(row: number): string {
  return noteLabel(BASS_LOW + row);
}

export type Params = Record<string, number>;

export interface ControlSpec {
  key: string;
  label: string;
  options?: string[];
  jack?: string;
  group?: string;
}

export const CONTROLS: Record<Slot, ControlSpec[]> = {
  synth: [
    { key: 'filterType', label: 'Mode', options: ['LP', 'HP'], group: 'filter' },
    { key: 'cutoff', label: 'Cutoff', group: 'filter' },
    { key: 'res', label: 'Reso', group: 'filter' },
    { key: 'envAmt', label: 'Env', group: 'filter' },
    { key: 'attack', label: 'A', group: 'envelope' },
    { key: 'decay', label: 'D', group: 'envelope' },
    { key: 'sustain', label: 'S', group: 'envelope' },
    { key: 'release', label: 'R', group: 'envelope' },
    { key: 'gate', label: 'Gate', group: 'envelope' },
    { key: 'delayDiv', label: 'Time', options: ['1/8', '3/16', '1/4'], group: 'echo' },
    { key: 'feedback', label: 'Feedback', group: 'echo' },
    { key: 'mix', label: 'Mix', group: 'echo' },
    { key: 'duckIn', label: 'In', jack: 'synth-duck', group: 'sidechain' },
    { key: 'duck', label: 'Duck', group: 'sidechain' },
    { key: 'pitchIn', label: 'In', jack: 'synth-pitch', group: 'follow bass' },
    { key: 'follow', label: 'Root', options: ['Off', 'On'], group: 'follow bass' },
  ],
  drums: [
    { key: 'kickTone', label: 'Tone', group: 'Bass Drum' },
    { key: 'kickDecay', label: 'Decay', group: 'Bass Drum' },
    { key: 'kickLevel', label: 'Level', group: 'Bass Drum' },
    { key: 'snareTone', label: 'Tone', group: 'Snare' },
    { key: 'snareSnap', label: 'Snappy', group: 'Snare' },
    { key: 'snareLevel', label: 'Level', group: 'Snare' },
    { key: 'hatLevel', label: 'Level', group: 'Hi-Hat' },
    { key: 'openDecay', label: 'Decay', group: 'Open Hat' },
    { key: 'openLevel', label: 'Level', group: 'Open Hat' },
    { key: 'kickOut', label: 'Kick', jack: 'kick-out', group: 'Out' },
  ],
  bass: [
    { key: 'attack', label: 'A', group: 'envelope' },
    { key: 'decay', label: 'D', group: 'envelope' },
    { key: 'sustain', label: 'S', group: 'envelope' },
    { key: 'release', label: 'R', group: 'envelope' },
    { key: 'cutoff', label: 'Cutoff', group: 'filter' },
    { key: 'peak', label: 'Peak', group: 'filter' },
    { key: 'env', label: 'Env', group: 'filter' },
    { key: 'sub', label: 'Sub', group: 'vco' },
    { key: 'glide', label: 'Glide', group: 'vco' },
    { key: 'gate', label: 'Gate', group: 'vco' },
    { key: 'duckIn', label: 'In', jack: 'bass-duck', group: 'sidechain' },
    { key: 'duck', label: 'Duck', group: 'sidechain' },
    { key: 'pitchOut', label: 'Pitch', jack: 'bass-pitch', group: 'out' },
  ],
};

export const DEFAULT_PARAMS: Record<Slot, Params> = {
  synth: { filterType: 0, cutoff: 0.55, res: 0.3, envAmt: 0.45, attack: 0.03, decay: 0.35, sustain: 0.3, release: 0.35, gate: 0.4, delayDiv: 1, feedback: 0.55, mix: 0.45, duck: 0.5, follow: 0 },
  drums: { kickTone: 0.4, kickDecay: 0.6, kickLevel: 0.9, snareTone: 0.5, snareSnap: 0.6, snareLevel: 0.7, hatLevel: 0.5, openDecay: 0.5, openLevel: 0.5 },
  bass: { attack: 0.02, decay: 0.4, sustain: 0.35, release: 0.2, cutoff: 0.4, peak: 0.45, env: 0.5, sub: 0.5, glide: 0, gate: 0.5, duck: 0.35 },
};

export interface Transport {
  playing: boolean;
  startAt: number;
  bpm: number;
}

export interface State {
  drums: boolean[][];
  chordNotes: number[];
  chordSteps: boolean[];
  bass: number[];
  params: Record<Slot, Params>;
  transport: Transport;
}

export interface Player {
  id: string;
  name: string;
  slot: Slot | null;
}

export type Message =
  | { t: 'hello' }
  | { t: 'snapshot'; state: State }
  | { t: 'drums'; grid: boolean[][] }
  | { t: 'chords'; notes: number[]; steps: boolean[] }
  | { t: 'bass'; steps: number[] }
  | { t: 'params'; slot: Slot; params: Params }
  | { t: 'transport'; transport: Transport };

function row(hits: number[]): boolean[] {
  const r = Array(STEPS).fill(false);
  for (const h of hits) r[h] = true;
  return r;
}

function steps(map: Record<number, number>): number[] {
  const r = Array(STEPS).fill(-1);
  for (const [k, v] of Object.entries(map)) r[Number(k)] = v;
  return r;
}

export function defaultState(startAt: number): State {
  return {
    drums: [
      row([0, 8, 10]),
      row([4, 12]),
      row([2, 6, 10, 14]),
      row([15]),
    ],
    chordNotes: [57, 60, 64, 67],
    chordSteps: row([2, 6, 10, 14]),
    bass: steps({ 0: 9, 2: 9, 3: 9, 6: 7, 8: 9, 10: 9, 11: 12, 14: 4 }),
    params: structuredClone(DEFAULT_PARAMS),
    transport: { playing: true, startAt, bpm: 120 },
  };
}

export function stepMs(bpm: number): number {
  return 60000 / bpm / 4;
}

export function followOffset(state: State, step: number): number {
  if (state.params.synth.follow !== 1 || state.chordNotes.length === 0) return 0;
  let bassMidi = -1;
  for (let k = 0; k < STEPS; k++) {
    const row = state.bass[(step - k + STEPS) % STEPS];
    if (row >= 0) { bassMidi = BASS_LOW + row; break; }
  }
  if (bassMidi < 0) return 0;
  const root = Math.min(...state.chordNotes);
  let d = (((bassMidi - root) % 12) + 12) % 12;
  if (d > 6) d -= 12;
  return d;
}
