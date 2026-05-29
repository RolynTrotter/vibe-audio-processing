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

import { fft, ifft, nextPow2, isPow2 } from './fft.js';

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
 * Linear convolution of the analysis window with itself (w ⊛ w), computed via
 * the same zero-padded FFT path the signal uses, so it exactly matches the
 * window contribution of each block. Used to divide the windowing back out.
 */
function windowAutoConv(win, fftSize) {
  const wr = new Float64Array(fftSize);
  const wi = new Float64Array(fftSize);
  for (let i = 0; i < win.length; i++) wr[i] = win[i];
  fft(wr, wi);
  for (let i = 0; i < fftSize; i++) {
    const re = wr[i] * wr[i] - wi[i] * wi[i];
    const im = 2 * wr[i] * wi[i];
    wr[i] = re; wi[i] = im;
  }
  ifft(wr, wi);
  return wr; // length fftSize; the real part is (w ⊛ w), zero-padded
}

/**
 * Windowed spectral-multiply convolution (the PM's spec, done right).
 *
 * For each overlapping frame: Hann-window a block of A and a block of B, FFT
 * both, multiply the spectra, inverse-FFT, and overlap-add the result. Crucial
 * detail: each frame is zero-padded to twice its length before the FFT, so the
 * spectral multiply is a *linear* convolution per block rather than a circular
 * one. Circular convolution wraps its tail back onto the block start, and that
 * wrap-around discontinuity is the broadband "scratch" (and the lone spikes
 * that normalize the rest of the file down to silence). Zero-padding removes it.
 *
 * The windowing amplitude envelope is divided back out exactly via the
 * overlap-added window autocorrelation (w ⊛ w), so windows add no warble while
 * the signal-dependent level variation — the actual effect — is preserved.
 *
 * The shorter signal is looped to cover the longer one. Output is peak-limited.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @param {{frameSize?:number, overlap?:number, normalizeDb?:number}} [opts]
 */
export function crossSynthesis(a, b, opts = {}) {
  const frameSize = opts.frameSize || 2048;
  if (!isPow2(frameSize)) throw new Error('frameSize must be a power of two');
  const overlap = opts.overlap || 4; // 4 == 75% overlapping windows
  const hop = Math.max(1, Math.floor(frameSize / overlap));
  const win = hann(frameSize);

  const len = Math.max(a.length, b.length);
  if (len === 0) return new Float32Array(0);
  const sa = tileTo(a, len);
  const sb = tileTo(b, len);

  const fftSize = frameSize * 2; // zero-pad: makes the multiply a linear conv
  const outLen = len + fftSize;  // room for the convolution tail
  const out = new Float32Array(outLen);
  const env = new Float32Array(outLen); // overlap-added window envelope

  const wconv = windowAutoConv(win, fftSize);

  const ar = new Float64Array(fftSize), ai = new Float64Array(fftSize);
  const br = new Float64Array(fftSize), bi = new Float64Array(fftSize);

  for (let start = 0; start < len; start += hop) {
    for (let i = 0; i < fftSize; i++) {
      if (i < frameSize) {
        const idx = start + i;
        const wv = win[i];
        ar[i] = (idx < len ? sa[idx] : 0) * wv; ai[i] = 0;
        br[i] = (idx < len ? sb[idx] : 0) * wv; bi[i] = 0;
      } else {
        ar[i] = 0; ai[i] = 0; br[i] = 0; bi[i] = 0;
      }
    }

    fft(ar, ai);
    fft(br, bi);

    // Complex multiply A*B per bin. Zero-padding above makes this a linear
    // (non-wrapping) convolution of the two windowed blocks.
    for (let i = 0; i < fftSize; i++) {
      const xr = ar[i] * br[i] - ai[i] * bi[i];
      const xi = ar[i] * bi[i] + ai[i] * br[i];
      ar[i] = xr; ai[i] = xi;
    }

    ifft(ar, ai);

    for (let i = 0; i < fftSize; i++) {
      out[start + i] += ar[i];
      env[start + i] += wconv[i];
    }
  }

  // Divide the windowing back out. For constant inputs this reconstructs a
  // constant exactly; for real signals only the windowing modulation is
  // removed. Trim the convolution group delay (~half a window) to stay aligned.
  const delay = frameSize >> 1;
  const result = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const j = i + delay;
    const e = env[j];
    result[i] = e > 1e-6 ? out[j] / e : 0;
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
