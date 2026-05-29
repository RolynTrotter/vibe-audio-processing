import test from 'node:test';
import assert from 'node:assert/strict';

import { fft, ifft, nextPow2, isPow2 } from '../src/dsp/fft.js';
import { encodeWav, decodeWav } from '../src/dsp/wav.js';
import {
  toMono, resampleLinear, hann, normalizePeak, applyFade,
  crossSynthesis, trueConvolution, process,
} from '../src/dsp/convolve.js';

const maxAbs = (a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const allFinite = (a) => a.every((x) => Number.isFinite(x));

// Naive time-domain convolution, the oracle for the FFT version.
function naiveConv(a, b) {
  const out = new Float64Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  }
  return out;
}

test('nextPow2 / isPow2', () => {
  assert.equal(nextPow2(1), 1);
  assert.equal(nextPow2(5), 8);
  assert.equal(nextPow2(1024), 1024);
  assert.equal(nextPow2(1025), 2048);
  assert.ok(isPow2(2048));
  assert.ok(!isPow2(2047));
  assert.ok(!isPow2(0));
});

test('FFT round-trips to the original signal', () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const orig = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    orig[i] = Math.sin(i * 0.3) + 0.5 * Math.cos(i * 0.05);
    re[i] = orig[i];
  }
  fft(re, im);
  ifft(re, im);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re[i] - orig[i]) < 1e-9, `sample ${i}`);
    assert.ok(Math.abs(im[i]) < 1e-9, `imag ${i}`);
  }
});

test('FFT of a unit impulse is flat', () => {
  const n = 16;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re[0] = 1;
  fft(re, im);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re[i] - 1) < 1e-12);
    assert.ok(Math.abs(im[i]) < 1e-12);
  }
});

test('FFT rejects non-power-of-two lengths', () => {
  assert.throws(() => fft(new Float64Array(3), new Float64Array(3)));
});

test('WAV float encode/decode is lossless', () => {
  const sr = 44100;
  const ch = new Float32Array([0, 0.5, -0.5, 0.999, -0.999, 0.123456]);
  const buf = encodeWav([ch], sr, { float: true });
  const dec = decodeWav(buf);
  assert.equal(dec.sampleRate, sr);
  assert.equal(dec.channels.length, 1);
  assert.equal(dec.length, ch.length);
  for (let i = 0; i < ch.length; i++) {
    assert.ok(Math.abs(dec.channels[0][i] - ch[i]) < 1e-6, `sample ${i}`);
  }
});

test('WAV 16-bit round-trips within quantization', () => {
  const sr = 22050;
  const left = new Float32Array([0, 0.25, -0.25, 0.5]);
  const right = new Float32Array([0.1, -0.1, 0.75, -0.75]);
  const buf = encodeWav([left, right], sr, { bitDepth: 16 });
  const dec = decodeWav(buf);
  assert.equal(dec.channels.length, 2);
  assert.equal(dec.sampleRate, sr);
  const q = 1 / 32768 + 1e-7;
  for (let i = 0; i < left.length; i++) {
    assert.ok(Math.abs(dec.channels[0][i] - left[i]) < q);
    assert.ok(Math.abs(dec.channels[1][i] - right[i]) < q);
  }
});

test('decodeWav rejects non-RIFF data', () => {
  assert.throws(() => decodeWav(new Uint8Array([1, 2, 3, 4]).buffer));
});

test('toMono averages channels', () => {
  const m = toMono([new Float32Array([1, 0]), new Float32Array([0, 1])]);
  assert.deepEqual(Array.from(m), [0.5, 0.5]);
});

test('resampleLinear changes length by ratio and is a no-op at equal rates', () => {
  const x = new Float32Array([0, 1, 2, 3]);
  const same = resampleLinear(x, 44100, 44100);
  assert.deepEqual(Array.from(same), [0, 1, 2, 3]);
  const up = resampleLinear(x, 1000, 2000);
  assert.equal(up.length, 8);
  assert.ok(allFinite(up));
});

test('hann window endpoints are ~0 and centre is ~1', () => {
  const w = hann(8);
  assert.ok(Math.abs(w[0]) < 1e-9);
  assert.ok(Math.abs(w[4] - 1) < 1e-9);
});

test('normalizePeak hits the target level', () => {
  const x = new Float32Array([0.1, -0.2, 0.05]);
  normalizePeak(x, -6);
  const target = Math.pow(10, -6 / 20);
  assert.ok(Math.abs(maxAbs(x) - target) < 1e-6);
});

test('normalizePeak leaves silence untouched', () => {
  const x = new Float32Array([0, 0, 0]);
  normalizePeak(x, -1);
  assert.equal(maxAbs(x), 0);
});

test('applyFade ramps both ends to zero over ~fadeSec', () => {
  const sr = 44100;
  const x = new Float32Array(sr).fill(1); // 1 second of DC
  applyFade(x, sr, 0.01); // 10 ms => 441 samples each end
  assert.equal(x[0], 0);
  assert.equal(x[x.length - 1], 0);
  assert.ok(x[220] > 0 && x[220] < 1, 'mid-fade should be partial');
  assert.equal(x[441], 1, 'sample just past the fade should be untouched');
  assert.equal(x[x.length - 1 - 441], 1, 'tail just inside should be untouched');
});

test('applyFade clamps to half-length for very short signals', () => {
  const x = new Float32Array(6).fill(1);
  applyFade(x, 44100, 1.0); // would be huge; clamps to 3 each side
  assert.equal(x[0], 0);
  assert.equal(x[5], 0);
  assert.ok(x.every(Number.isFinite));
});

test('process applies the fade so output starts and ends at zero', () => {
  const sr = 44100;
  const srcA = { sampleRate: sr, channels: [new Float32Array(8192).map((_, i) => Math.sin(i * 0.2) + 0.5)] };
  const srcB = { sampleRate: sr, channels: [new Float32Array(8192).map((_, i) => Math.cos(i * 0.05) + 0.5)] };
  const { data } = process(srcA, srcB, { mode: 'cross', frameSize: 1024 });
  assert.equal(data[0], 0);
  assert.equal(data[data.length - 1], 0);
});

test('trueConvolution matches naive convolution (shape, up to scale)', () => {
  const a = new Float32Array([1, 2, 3, 4, 0, -1]);
  const b = new Float32Array([0.5, -0.25, 0.1]);
  const got = trueConvolution(a, b, { normalizeDb: 0 });
  const ref = naiveConv(a, b);
  assert.equal(got.length, a.length + b.length - 1);
  // Compare normalized shapes (trueConvolution peak-normalizes).
  const refPeak = maxAbs(ref);
  for (let i = 0; i < got.length; i++) {
    assert.ok(Math.abs(got[i] - ref[i] / refPeak) < 1e-5, `tap ${i}`);
  }
});

test('trueConvolution output never clips', () => {
  const a = new Float32Array(500).map((_, i) => Math.sin(i * 0.2));
  const b = new Float32Array(300).map((_, i) => Math.sin(i * 0.05));
  const out = trueConvolution(a, b);
  assert.ok(maxAbs(out) <= Math.pow(10, -1 / 20) + 1e-6);
  assert.ok(allFinite(out));
});

test('crossSynthesis: correct length, finite, no clipping', () => {
  const a = new Float32Array(5000).map((_, i) => Math.sin(i * 0.1));
  const b = new Float32Array(3000).map((_, i) => Math.sin(i * 0.03));
  const out = crossSynthesis(a, b, { frameSize: 1024 });
  assert.equal(out.length, 5000); // length of the longer input
  assert.ok(allFinite(out));
  assert.ok(maxAbs(out) <= Math.pow(10, -1 / 20) + 1e-6);
});

test('crossSynthesis: windowing is flat for constant inputs (no warble/scratch)', () => {
  // If A and B are constant, the windowed spectral multiply must reconstruct a
  // constant. Any periodic ripple here would be the windowing artifact the PM
  // heard as "scratch". Check the steady-state interior is essentially flat.
  const N = 8192;
  const a = new Float32Array(N).fill(0.5);
  const b = new Float32Array(N).fill(0.8);
  const out = crossSynthesis(a, b, { frameSize: 1024, overlap: 4 });
  const interior = out.subarray(2048, N - 2048);
  let min = Infinity, max = -Infinity;
  for (const x of interior) { if (x < min) min = x; if (x > max) max = x; }
  const ripple = (max - min) / Math.max(1e-9, Math.abs(max));
  assert.ok(ripple < 1e-3, `interior should be flat, got ripple ${ripple}`);
});

test('crossSynthesis: real signals produce audible (non-silent) output', () => {
  // Regression for the "sometimes a silent file" report: the old circular-
  // convolution wrap spike made normalization crush everything else to zero.
  const N = 16384;
  const a = new Float32Array(N);
  const b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    a[i] = Math.sin(2 * Math.PI * 220 * i / 44100);
    b[i] = (Math.random() * 2 - 1) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * i / 44100));
  }
  const out = crossSynthesis(a, b, { frameSize: 2048, overlap: 4 });
  let rms = 0;
  for (const x of out) rms += x * x;
  rms = Math.sqrt(rms / out.length);
  assert.ok(rms > 0.01, `output should be audible, got rms ${rms}`);
  assert.ok(out.every(Number.isFinite));
});

test('crossSynthesis: more overlap still reconstructs a constant', () => {
  const a = new Float32Array(8192).fill(0.3);
  const b = new Float32Array(8192).fill(0.3);
  for (const ov of [2, 4, 8]) {
    const out = crossSynthesis(a, b, { frameSize: 1024, overlap: ov });
    const interior = out.subarray(2048, 6144);
    let min = Infinity, max = -Infinity;
    for (const x of interior) { if (x < min) min = x; if (x > max) max = x; }
    assert.ok((max - min) / Math.abs(max) < 5e-3, `overlap ${ov} not flat`);
  }
});

test('crossSynthesis rejects non-power-of-two frame size', () => {
  assert.throws(() => crossSynthesis(new Float32Array(10), new Float32Array(10), { frameSize: 1000 }));
});

test('crossSynthesis handles empty input', () => {
  assert.equal(crossSynthesis(new Float32Array(0), new Float32Array(0)).length, 0);
});

test('process: cross mode resamples to the higher rate and downmixes', () => {
  const srcA = { sampleRate: 22050, channels: [new Float32Array(2000).map((_, i) => Math.sin(i * 0.1))] };
  const srcB = {
    sampleRate: 44100,
    channels: [
      new Float32Array(4000).map((_, i) => Math.sin(i * 0.02)),
      new Float32Array(4000).map((_, i) => Math.cos(i * 0.02)),
    ],
  };
  const { data, sampleRate } = process(srcA, srcB, { mode: 'cross', frameSize: 1024 });
  assert.equal(sampleRate, 44100);
  assert.ok(data.length > 0);
  assert.ok(allFinite(data));
  assert.ok(maxAbs(data) <= Math.pow(10, -1 / 20) + 1e-6);
});

test('process: convolution mode produces linear-convolution length', () => {
  const srcA = { sampleRate: 44100, channels: [new Float32Array(1000).fill(0).map((_, i) => Math.sin(i * 0.1))] };
  const srcB = { sampleRate: 44100, channels: [new Float32Array(200).fill(0).map((_, i) => Math.sin(i * 0.3))] };
  const { data } = process(srcA, srcB, { mode: 'convolution' });
  assert.equal(data.length, 1000 + 200 - 1);
});

test('end-to-end: encode -> decode -> process -> encode', () => {
  const sr = 44100;
  const a = new Float32Array(2048).map((_, i) => Math.sin(i * 0.12));
  const b = new Float32Array(2048).map((_, i) => Math.sin(i * 0.4) * 0.6);
  const da = decodeWav(encodeWav([a], sr, { float: true }));
  const db = decodeWav(encodeWav([b], sr, { float: true }));
  const { data, sampleRate } = process(da, db, { mode: 'cross', frameSize: 1024 });
  const wav = encodeWav([data], sampleRate, { bitDepth: 16 });
  const round = decodeWav(wav);
  assert.equal(round.sampleRate, sr);
  assert.ok(round.length > 0);
  assert.ok(allFinite(round.channels[0]));
});
