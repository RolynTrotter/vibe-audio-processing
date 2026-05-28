// Audio convolution engine: two algorithms plus the supporting DSP.
//
//  1. crossSynthesis  - the PM's spec. Short-time FFT of both signals, complex
//                       multiply of matching frames, overlap-add resynthesis.
//                       Time-varying: signal A takes on B's evolving timbre.
//  2. trueConvolution - full linear convolution via a single zero-padded FFT.
//                       Convolution-reverb character (e.g. play A in B's space).
//
// Everything finishes with peak normalization so the output can never clip
// ("no peeking"). Pure JS, shared by the browser app and the Node tests.

import { fft, ifft, nextPow2 } from './fft.js';

/** Downmix planar channels to a single mono Float32Array. */
export function toMono(channels) {
  const n = channels.length;
  if (n === 1) return channels[0].slice();
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (let c = 0; c < n; c++) {
    const ch = channels[c];
    for (let i = 0; i < len; i++) out[i] += ch[i];
  }
  for (let i = 0; i < len; i++) out[i] /= n;
  return out;
}

/** Linear-interpolation resampler. Adequate for matching arbitrary rates. */
export function resampleLinear(data, fromRate, toRate) {
  if (fromRate === toRate || data.length === 0) return data.slice();
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(data.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, data.length - 1);
    const t = srcPos - i0;
    out[i] = data[i0] * (1 - t) + data[i1] * t;
  }
  return out;
}

/** Periodic Hann window of length n (matches numpy/scipy STFT convention). */
export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  }
  return w;
}

/**
 * Peak-normalize in place to a target level in dBFS (default -1 dBFS).
 * Guarantees |sample| <= target after scaling, so the file cannot clip.
 */
export function normalizePeak(data, targetDb = -1) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  if (peak === 0) return data;
  const target = Math.pow(10, targetDb / 20);
  const gain = target / peak;
  for (let i = 0; i < data.length; i++) data[i] *= gain;
  return data;
}

/** Tile `data` (looping) to exactly `len` samples. */
function tileTo(data, len) {
  if (data.length === 0) return new Float32Array(len);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = data[i % data.length];
  return out;
}

/**
 * Spectral cross-synthesis (PM spec): STFT both signals with a Hann window
 * and 50% overlap, complex-multiply matching frames, then overlap-add.
 *
 * The shorter signal is looped so the full duration of the longer one is
 * processed. Output is peak-normalized.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @param {{frameSize?:number, normalizeDb?:number}} [opts]
 */
export function crossSynthesis(a, b, opts = {}) {
  const frameSize = opts.frameSize || 2048;
  if ((frameSize & (frameSize - 1)) !== 0) {
    throw new Error('frameSize must be a power of two');
  }
  const hop = frameSize >> 1; // 50% overlap == "2 window overlap"
  const win = hann(frameSize);

  const len = Math.max(a.length, b.length);
  if (len === 0) return new Float32Array(0);
  const sa = tileTo(a, len);
  const sb = tileTo(b, len);

  // Pad so the final frame is whole, plus a frame of head/tail room.
  const padded = len + frameSize;
  const out = new Float32Array(padded);
  const norm = new Float32Array(padded); // running sum of squared windows (COLA)

  const ar = new Float64Array(frameSize), ai = new Float64Array(frameSize);
  const br = new Float64Array(frameSize), bi = new Float64Array(frameSize);

  // Scale keeps the complex multiply from exploding before normalization;
  // the final peak-normalize removes any residual level dependence.
  const scale = 1 / frameSize;

  for (let start = 0; start + frameSize <= padded; start += hop) {
    for (let i = 0; i < frameSize; i++) {
      const idx = start + i;
      const sav = idx < len ? sa[idx] : 0;
      const sbv = idx < len ? sb[idx] : 0;
      const wv = win[i];
      ar[i] = sav * wv; ai[i] = 0;
      br[i] = sbv * wv; bi[i] = 0;
    }

    fft(ar, ai);
    fft(br, bi);

    // Complex multiply A*B per bin (== circular convolution within the block).
    for (let i = 0; i < frameSize; i++) {
      const xr = ar[i] * br[i] - ai[i] * bi[i];
      const xi = ar[i] * bi[i] + ai[i] * br[i];
      ar[i] = xr * scale;
      ai[i] = xi * scale;
    }

    ifft(ar, ai);

    // Overlap-add with a synthesis Hann window (COLA-correct reconstruction).
    for (let i = 0; i < frameSize; i++) {
      const idx = start + i;
      const wv = win[i];
      out[idx] += ar[i] * wv;
      norm[idx] += wv * wv;
    }
  }

  // Divide out the overlapped window energy where it's meaningful.
  const result = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = norm[i] > 1e-8 ? out[i] / norm[i] : out[i];
  }

  return normalizePeak(result, opts.normalizeDb ?? -1);
}

/**
 * True linear convolution of two signals via a single zero-padded FFT.
 * Output length is a.length + b.length - 1, peak-normalized.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @param {{normalizeDb?:number}} [opts]
 */
export function trueConvolution(a, b, opts = {}) {
  if (a.length === 0 || b.length === 0) return new Float32Array(0);
  const outLen = a.length + b.length - 1;
  const n = nextPow2(outLen);

  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a);
  br.set(b);

  fft(ar, ai);
  fft(br, bi);

  for (let i = 0; i < n; i++) {
    const xr = ar[i] * br[i] - ai[i] * bi[i];
    const xi = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = xr;
    ai[i] = xi;
  }

  ifft(ar, ai);

  const result = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) result[i] = ar[i];

  return normalizePeak(result, opts.normalizeDb ?? -1);
}

/**
 * High-level entry point used by the worker. Takes two decoded sources
 * (each {sampleRate, channels}) and returns a mono result plus its rate.
 *
 * @param {{sampleRate:number, channels:Float32Array[]}} srcA
 * @param {{sampleRate:number, channels:Float32Array[]}} srcB
 * @param {{mode?:'cross'|'convolution', frameSize?:number, normalizeDb?:number}} [opts]
 * @returns {{data:Float32Array, sampleRate:number}}
 */
export function process(srcA, srcB, opts = {}) {
  const mode = opts.mode || 'cross';
  const sampleRate = Math.max(srcA.sampleRate, srcB.sampleRate);

  let a = toMono(srcA.channels);
  let b = toMono(srcB.channels);
  a = resampleLinear(a, srcA.sampleRate, sampleRate);
  b = resampleLinear(b, srcB.sampleRate, sampleRate);

  let data;
  if (mode === 'convolution') {
    data = trueConvolution(a, b, opts);
  } else {
    data = crossSynthesis(a, b, opts);
  }
  return { data, sampleRate };
}
