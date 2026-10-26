import { BASS_LOW, SAMPLE_RATE, STEPS, followOffset, stepMs, type Params, type Slot, type State, type Transport } from './state';

const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;
const DELAY_BEATS = [0.5, 0.75, 1];
const HAT_RATIOS = [1, 1.342, 1.2312, 1.6532, 1.9523, 2.1239];

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function expo(v: number, min: number, max: number): number {
  return min * Math.pow(max / min, v);
}

function lin(v: number, min: number, max: number): number {
  return min + (max - min) * v;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private drumBus!: GainNode;
  private synthBus!: GainNode;
  private bassBus!: GainNode;
  private echoSend!: GainNode;
  private echoDelay!: DelayNode;
  private echoFeedback!: GainNode;
  private synthDuck!: GainNode;
  private bassDuck!: GainNode;
  private samplerBus!: GainNode;
  private samplerDuck!: GainNode;
  private samplerEchoSend!: GainNode;
  private samplerEchoDelay!: DelayNode;
  private samplerEchoFeedback!: GainNode;
  private reverbSend!: GainNode;
  private volumes!: Record<Slot, GainNode>;
  private noise!: AudioBuffer;
  private sampleRaw: Float32Array | null = null;
  private sampleBuffer: AudioBuffer | null = null;
  private sampleReversed: AudioBuffer | null = null;
  private bassVoice: { gain: GainNode; oscs: OscillatorNode[]; hz: number } | null = null;
  private nextStep = 0;
  private timer: number | null = null;
  private state: State | null = null;
  private transport: Transport | null = null;
  private serverNow: () => number;
  private onStep: (step: number) => void;
  private stateListeners: Array<() => void> = [];

  constructor(serverNow: () => number, onStep: (step: number) => void) {
    this.serverNow = serverNow;
    this.onStep = onStep;
  }

  private build(): AudioContext {
    const ctx = new AudioContext();
    this.ctx = ctx;
    for (const cb of this.stateListeners) ctx.addEventListener('statechange', cb);
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 3;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);
    this.noise = this.makeNoise();

    this.volumes = {
      synth: ctx.createGain(),
      drums: ctx.createGain(),
      bass: ctx.createGain(),
      sampler: ctx.createGain(),
    };
    for (const v of Object.values(this.volumes)) v.connect(this.master);

    this.drumBus = ctx.createGain();
    this.drumBus.connect(this.volumes.drums);

    this.synthDuck = ctx.createGain();
    this.synthDuck.connect(this.volumes.synth);
    this.bassDuck = ctx.createGain();
    this.bassDuck.connect(this.volumes.bass);
    this.samplerDuck = ctx.createGain();
    this.samplerDuck.connect(this.volumes.sampler);

    this.synthBus = ctx.createGain();
    this.synthBus.gain.value = 1.4;
    this.buildChorus(this.synthBus).connect(this.synthDuck);
    this.echoSend = ctx.createGain();
    this.echoDelay = ctx.createDelay(2);
    this.echoFeedback = ctx.createGain();
    const echoTone = this.filter(2200, 'lowpass', 0.7);
    const echoBody = this.filter(250, 'highpass', 0.7);
    this.synthBus.connect(this.echoSend).connect(this.echoDelay);
    this.echoDelay.connect(echoTone).connect(echoBody).connect(this.echoFeedback).connect(this.echoDelay);
    this.echoFeedback.connect(this.synthDuck);

    this.bassBus = ctx.createGain();
    this.bassBus.gain.value = 0.9;
    this.bassBus.connect(this.drive(1.6)).connect(this.bassDuck);

    this.samplerBus = ctx.createGain();
    this.samplerBus.connect(this.samplerDuck);
    this.samplerEchoSend = ctx.createGain();
    this.samplerEchoDelay = ctx.createDelay(2);
    this.samplerEchoFeedback = ctx.createGain();
    const samplerEchoTone = this.filter(2600, 'lowpass', 0.7);
    this.samplerBus.connect(this.samplerEchoSend).connect(this.samplerEchoDelay);
    this.samplerEchoDelay.connect(samplerEchoTone).connect(this.samplerEchoFeedback).connect(this.samplerEchoDelay);
    this.samplerEchoFeedback.connect(this.samplerDuck);
    this.reverbSend = ctx.createGain();
    const reverb = ctx.createConvolver();
    reverb.buffer = this.makeImpulse(2.2);
    this.samplerBus.connect(this.reverbSend).connect(reverb).connect(this.samplerDuck);

    if (this.sampleRaw) this.buildSampleBuffers(this.sampleRaw);
    if (this.state) this.applyLevels();
    return ctx;
  }

  setSample(data: Float32Array | null): void {
    this.sampleRaw = data;
    if (!this.ctx) return;
    if (data) this.buildSampleBuffers(data);
    else this.sampleBuffer = this.sampleReversed = null;
  }

  private buildSampleBuffers(data: Float32Array): void {
    const ctx = this.ctx!;
    const buffer = ctx.createBuffer(1, data.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(data);
    const reversed = ctx.createBuffer(1, data.length, SAMPLE_RATE);
    const back = reversed.getChannelData(0);
    for (let i = 0; i < data.length; i++) back[i] = data[data.length - 1 - i];
    this.sampleBuffer = buffer;
    this.sampleReversed = reversed;
  }

  private makeImpulse(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
    }
    return buf;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  onStateChange(cb: () => void): void {
    this.stateListeners.push(cb);
    this.ctx?.addEventListener('statechange', cb);
  }

  async resume(): Promise<void> {
    const ctx = this.ctx ?? this.build();
    if (ctx.state !== 'running') await ctx.resume();
    for (const cb of this.stateListeners) cb();
  }

  setState(state: State): void {
    const t = state.transport;
    const transportChanged =
      !this.transport ||
      this.transport.startAt !== t.startAt ||
      this.transport.bpm !== t.bpm ||
      this.transport.playing !== t.playing;
    this.state = state;
    this.transport = { ...t };
    this.applyLevels();
    if (transportChanged) this.realign();
  }

  start(): void {
    if (this.timer !== null) return;
    this.realign();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private applyLevels(): void {
    if (!this.ctx) return;
    const s = this.state!;
    const p = s.params.synth;
    const beat = 60 / s.transport.bpm;
    const t = this.ctx.currentTime;
    this.echoDelay.delayTime.setTargetAtTime(beat * (DELAY_BEATS[p.delayDiv] ?? 1), t, 0.05);
    this.echoFeedback.gain.setTargetAtTime(lin(p.feedback, 0, 0.85), t, 0.02);
    this.echoSend.gain.setTargetAtTime(lin(p.mix, 0, 0.9), t, 0.02);
    const sp = s.params.sampler;
    this.samplerEchoDelay.delayTime.setTargetAtTime(beat * (DELAY_BEATS[sp.echoDiv] ?? 1), t, 0.05);
    this.samplerEchoFeedback.gain.setTargetAtTime(lin(sp.echoFeedback, 0, 0.85), t, 0.02);
    this.samplerEchoSend.gain.setTargetAtTime(lin(sp.echoMix, 0, 0.9), t, 0.02);
    this.reverbSend.gain.setTargetAtTime(lin(sp.reverb, 0, 0.8), t, 0.02);
    for (const slot of Object.keys(this.volumes) as Slot[]) {
      const v = s.params[slot].volume ?? 0.7;
      this.volumes[slot].gain.setTargetAtTime(v * v * 2, t, 0.02);
    }
  }

  currentStep(): number {
    if (!this.state || !this.state.transport.playing) return -1;
    const { startAt, bpm } = this.state.transport;
    const elapsed = this.serverNow() - startAt;
    if (elapsed < 0) return -1;
    return Math.floor(elapsed / stepMs(bpm)) % STEPS;
  }

  private realign(): void {
    if (!this.state) return;
    const { startAt, bpm } = this.state.transport;
    this.nextStep = Math.max(0, Math.ceil((this.serverNow() - startAt) / stepMs(bpm)));
  }

  private tick(): void {
    if (!this.state || !this.state.transport.playing) return;
    if (!this.running) {
      this.realign();
      const step = this.currentStep();
      if (step >= 0) this.onStep(step);
      return;
    }
    const ctx = this.ctx!;
    const { startAt, bpm } = this.state.transport;
    const ms = stepMs(bpm);
    const now = this.serverNow();
    while (true) {
      const dt = (startAt + this.nextStep * ms - now) / 1000;
      if (dt > LOOKAHEAD_S) break;
      if (dt > -0.05) {
        const when = ctx.currentTime + Math.max(dt, 0);
        this.scheduleStep(this.nextStep % STEPS, when, ms / 1000);
      }
      this.nextStep++;
    }
  }

  private scheduleStep(step: number, when: number, stepS: number): void {
    const s = this.state!;
    const d = s.params.drums;
    if (s.drums[0][step]) {
      this.kick(when, d);
      this.duck(when);
    }
    if (s.drums[1][step]) this.snare(when, d);
    if (s.drums[2][step]) this.hat(when, 0.04, lin(d.hatLevel, 0, 0.5));
    if (s.drums[3][step]) this.hat(when, lin(d.openDecay, 0.12, 0.8), lin(d.openLevel, 0, 0.5));
    if (s.chordSteps[step]) {
      const offset = followOffset(s, step);
      for (const n of s.chordNotes) this.pad(n + offset, when, stepS, s.params.synth);
    }
    const bass = s.bass[step];
    if (bass >= 0) this.bass(BASS_LOW + bass, when, stepS, s.params.bass);
    if (s.sampler.steps[step] && this.sampleBuffer) this.playSample(when, s.params.sampler);
    const delay = Math.max(0, (when - this.ctx!.currentTime) * 1000);
    window.setTimeout(() => this.onStep(step), delay);
  }

  private makeNoise(): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  private filter(freq: number, type: BiquadFilterType, q: number): BiquadFilterNode {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private drive(amount: number): WaveShaperNode {
    const shaper = this.ctx!.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    return shaper;
  }

  private buildChorus(input: AudioNode): AudioNode {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    input.connect(out);
    for (const [base, rate] of [[0.011, 0.6], [0.017, 0.83]]) {
      const delay = ctx.createDelay(0.1);
      delay.delayTime.value = base;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const depth = ctx.createGain();
      depth.gain.value = 0.0025;
      lfo.connect(depth).connect(delay.delayTime);
      lfo.start();
      const wet = ctx.createGain();
      wet.gain.value = 0.4;
      input.connect(delay).connect(wet).connect(out);
    }
    return out;
  }

  private env(dest: AudioNode, when: number, peak: number, attack: number, decay: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
    g.connect(dest);
    return g;
  }

  private duck(when: number): void {
    const s = this.state!;
    const tau = (60 / s.transport.bpm) * 0.25;
    const targets = [
      [this.synthDuck, s.params.synth.duck],
      [this.bassDuck, s.params.bass.duck],
      [this.samplerDuck, s.params.sampler.duck],
    ] as const;
    for (const [gain, amount] of targets) {
      if (amount <= 0) continue;
      gain.gain.setTargetAtTime(1 - amount * 0.95, when, 0.004);
      gain.gain.setTargetAtTime(1, when + 0.04, tau);
    }
  }

  private playSample(when: number, p: Params): void {
    const ctx = this.ctx!;
    const buffer = (p.reverse === 1 ? this.sampleReversed : this.sampleBuffer)!;
    const rate = Math.pow(2, (p.pitch * 24 - 12) / 12);
    const total = buffer.duration;
    const startSec = Math.min(p.start * total, Math.max(0, total - 0.05));
    const lenSec = Math.max(0.05, Math.min(total - startSec, lin(p.length, 0.05, total)));
    const offset = p.reverse === 1 ? Math.max(0, total - startSec - lenSec) : startSec;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const lp = this.filter(expo(p.cutoff, 200, 12000), 'lowpass', 0.8);
    const g = ctx.createGain();
    const playSec = lenSec / rate;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.9, when + 0.004);
    g.gain.setValueAtTime(0.9, when + Math.max(0.004, playSec - 0.03));
    g.gain.linearRampToValueAtTime(0.0001, when + playSec);
    src.connect(lp).connect(g).connect(this.samplerBus);
    src.start(when, offset);
    src.stop(when + playSec + 0.01);
  }

  private kick(when: number, p: Params): void {
    const ctx = this.ctx!;
    const decay = lin(p.kickDecay, 0.15, 0.9);
    const level = lin(p.kickLevel, 0, 1.1);
    const osc = ctx.createOscillator();
    const start = lin(p.kickTone, 90, 260);
    osc.frequency.setValueAtTime(start, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.08);
    osc.connect(this.env(this.drumBus, when, level, 0.002, decay));
    osc.start(when);
    osc.stop(when + decay + 0.05);
    const click = ctx.createBufferSource();
    click.buffer = this.noise;
    click.connect(this.filter(3000, 'highpass', 0.7)).connect(this.env(this.drumBus, when, level * 0.25, 0.001, 0.015));
    click.start(when);
    click.stop(when + 0.03);
  }

  private snare(when: number, p: Params): void {
    const ctx = this.ctx!;
    const level = lin(p.snareLevel, 0, 0.9);
    const tone = lin(p.snareTone, 150, 320);
    for (const [ratio, amt] of [[1, 0.5], [1.74, 0.3]]) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(tone * ratio, when);
      osc.frequency.exponentialRampToValueAtTime(tone * ratio * 0.7, when + 0.1);
      osc.connect(this.env(this.drumBus, when, level * amt, 0.002, 0.12));
      osc.start(when);
      osc.stop(when + 0.2);
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const snap = lin(p.snareSnap, 0.1, 0.9);
    src.connect(this.filter(1500, 'highpass', 0.5)).connect(this.env(this.drumBus, when, level * snap, 0.002, lin(p.snareSnap, 0.08, 0.28)));
    src.start(when);
    src.stop(when + 0.4);
  }

  private hat(when: number, decay: number, level: number): void {
    const ctx = this.ctx!;
    if (level <= 0) return;
    const bp = this.filter(10000, 'bandpass', 1.2);
    const hp = this.filter(7500, 'highpass', 0.7);
    bp.connect(hp).connect(this.env(this.drumBus, when, level, 0.001, decay));
    for (const ratio of HAT_RATIOS) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 320 * ratio;
      osc.connect(bp);
      osc.start(when);
      osc.stop(when + decay + 0.05);
    }
  }

  private adsr(p: Params): { a: number; d: number; s: number; r: number } {
    return {
      a: expo(p.attack, 0.002, 1.5),
      d: expo(p.decay, 0.02, 2.5),
      s: p.sustain,
      r: expo(p.release, 0.02, 3),
    };
  }

  private ampEnvelope(g: GainNode, when: number, peak: number, gateEnd: number, e: { a: number; d: number; s: number; r: number }): number {
    const sustain = Math.max(0.0001, peak * e.s);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + e.a);
    g.gain.setTargetAtTime(sustain, when + e.a, e.d / 4);
    const releaseAt = Math.max(gateEnd, when + e.a);
    g.gain.setTargetAtTime(0.0001, releaseAt, e.r / 4);
    return releaseAt + e.r * 1.5;
  }

  private filterEnvelope(f: BiquadFilterNode, when: number, base: number, peak: number, gateEnd: number, e: { a: number; d: number; s: number; r: number }): void {
    const sustain = base + (peak - base) * e.s;
    f.frequency.setValueAtTime(base, when);
    f.frequency.linearRampToValueAtTime(peak, when + e.a);
    f.frequency.setTargetAtTime(sustain, when + e.a, e.d / 4);
    f.frequency.setTargetAtTime(base, Math.max(gateEnd, when + e.a), e.r / 4);
  }

  private pad(midi: number, when: number, stepS: number, p: Params): void {
    const ctx = this.ctx!;
    const e = this.adsr(p);
    const gateEnd = when + stepS * expo(p.gate, 0.25, 4);
    const g = ctx.createGain();
    const stopAt = this.ampEnvelope(g, when, 0.16, gateEnd, e);
    g.connect(this.synthBus);
    const base = expo(p.cutoff, 120, 9000);
    const peak = Math.min(16000, base * lin(p.envAmt, 1, 8));
    const lp = this.filter(base, p.filterType === 1 ? 'highpass' : 'lowpass', lin(p.res, 0.5, 11));
    this.filterEnvelope(lp, when, base, peak, gateEnd, e);
    lp.connect(g);
    const hz = midiToHz(midi);
    for (const [type, detune, oct, level] of [['sawtooth', -9, 0, 0.5], ['sawtooth', 9, 0, 0.5], ['square', 0, -1, 0.22]] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz * Math.pow(2, oct);
      osc.detune.value = detune;
      const vg = ctx.createGain();
      vg.gain.value = level;
      osc.connect(vg).connect(lp);
      osc.start(when);
      osc.stop(stopAt);
    }
  }

  private bass(midi: number, when: number, stepS: number, p: Params): void {
    const ctx = this.ctx!;
    const e = this.adsr(p);
    const gateEnd = when + stepS * expo(p.gate, 0.25, 2);
    const hz = midiToHz(midi);
    const previous = this.bassVoice;
    if (previous) {
      const gain = previous.gain.gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
      if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(when);
      else gain.cancelScheduledValues(when);
      gain.setTargetAtTime(0.0001, when, 0.004);
      for (const o of previous.oscs) o.stop(when + 0.05);
    }
    const g = ctx.createGain();
    const stopAt = this.ampEnvelope(g, when, 0.55, gateEnd, e);
    const base = expo(p.cutoff, 60, 5000);
    const peak = Math.min(12000, base * lin(p.env, 1, 10));
    const lp = this.filter(base, 'lowpass', lin(p.peak, 0.7, 20));
    this.filterEnvelope(lp, when, base, peak, gateEnd, e);
    const hp = this.filter(35, 'highpass', 0.7);
    hp.connect(lp).connect(g).connect(this.bassBus);
    const glide = previous && p.glide > 0 ? expo(p.glide, 0.01, 0.6) : 0;
    const fromHz = previous?.hz ?? hz;
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    const pulse = ctx.createOscillator();
    pulse.type = 'square';
    pulse.detune.value = 6;
    const pulseGain = ctx.createGain();
    pulseGain.gain.value = 0.35;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    const subGain = ctx.createGain();
    subGain.gain.value = lin(p.sub, 0, 0.9);
    for (const [o, ratio] of [[saw, 1], [pulse, 1], [sub, 0.5]] as const) {
      if (glide > 0) {
        o.frequency.setValueAtTime(fromHz * ratio, when);
        o.frequency.exponentialRampToValueAtTime(hz * ratio, when + glide);
      } else {
        o.frequency.value = hz * ratio;
      }
    }
    saw.connect(hp);
    pulse.connect(pulseGain).connect(hp);
    sub.connect(subGain).connect(hp);
    const oscs = [saw, pulse, sub];
    for (const o of oscs) { o.start(when); o.stop(stopAt); }
    this.bassVoice = { gain: g, oscs, hz };
  }
}
