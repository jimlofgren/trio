import { SAMPLE_MAX_SECONDS, SAMPLE_RATE } from './state';

export interface Recording {
  stop: () => void;
  result: Promise<Float32Array>;
}

export function startRecording(stream: MediaStream, onTick: (seconds: number) => void): Recording {
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const started = Date.now();
  const timer = window.setInterval(() => onTick((Date.now() - started) / 1000), 100);
  const stop = () => { if (recorder.state === 'recording') recorder.stop(); };
  const limit = window.setTimeout(stop, SAMPLE_MAX_SECONDS * 1000);
  const result = new Promise<Float32Array>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('recording failed'));
    recorder.onstop = async () => {
      window.clearInterval(timer);
      window.clearTimeout(limit);
      stream.getTracks().forEach((t) => t.stop());
      try {
        resolve(await toMono16k(new Blob(chunks, { type: recorder.mimeType })));
      } catch (err) {
        reject(err);
      }
    };
  });
  recorder.start();
  return { stop, result };
}

async function toMono16k(blob: Blob): Promise<Float32Array> {
  const decodeCtx = new AudioContext();
  const decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
  await decodeCtx.close();
  const seconds = Math.min(decoded.duration, SAMPLE_MAX_SECONDS);
  const offline = new OfflineAudioContext(1, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return normalise(trimSilence(rendered.getChannelData(0)));
}

function trimSilence(data: Float32Array): Float32Array {
  const threshold = 0.02;
  const margin = Math.floor(SAMPLE_RATE * 0.03);
  let start = 0;
  while (start < data.length && Math.abs(data[start]) < threshold) start++;
  let end = data.length;
  while (end > start && Math.abs(data[end - 1]) < threshold) end--;
  if (end - start < SAMPLE_RATE * 0.05) return data;
  return data.slice(Math.max(0, start - margin), Math.min(data.length, end + margin * 4));
}

function normalise(data: Float32Array): Float32Array {
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  if (peak < 0.001) return data;
  const gain = 0.9 / peak;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * gain;
  return out;
}

const BIAS = 0x84;
const CLIP = 32635;

function mulawEncode(x: number): number {
  let s = Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1) { /* find segment */ }
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

function mulawDecode(u: number): number {
  const b = ~u & 0xff;
  const sign = b & 0x80;
  const exp = (b >> 4) & 7;
  const mant = b & 0x0f;
  const s = (((mant << 3) + BIAS) << exp) - BIAS;
  return (sign ? -s : s) / 32768;
}

export function encodeSample(data: Float32Array): string {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = mulawEncode(data[i]);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

export function decodeSample(encoded: string): Float32Array {
  const bin = atob(encoded);
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = mulawDecode(bin.charCodeAt(i));
  return out;
}

export const CHUNK_CHARS = 40000;

export function splitChunks(encoded: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < encoded.length; i += CHUNK_CHARS) parts.push(encoded.slice(i, i + CHUNK_CHARS));
  return parts;
}
