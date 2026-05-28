// Off-main-thread audio processing so the phone UI never freezes.
//
// Receives two decoded sources, runs the convolution engine, and posts back an
// encoded WAV. WAV decoding happens here when possible; if a file isn't a
// WAV we can parse, the main thread decodes it via the Web Audio API and sends
// the raw channel data instead.

import { decodeWav, encodeWav } from './dsp/wav.js';
import { process } from './dsp/convolve.js';

self.onmessage = (e) => {
  const { id, a, b, opts } = e.data;
  try {
    const srcA = toSource(a);
    const srcB = toSource(b);
    const { data, sampleRate } = process(srcA, srcB, opts);
    const wav = encodeWav([data], sampleRate, { bitDepth: 16 });
    self.postMessage(
      { id, ok: true, wav, sampleRate, frames: data.length },
      [wav]
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};

// A source is either { buffer } (raw WAV bytes to decode here) or
// { channels, sampleRate } (already decoded on the main thread).
function toSource(input) {
  if (input.channels) {
    return { sampleRate: input.sampleRate, channels: input.channels };
  }
  return decodeWav(input.buffer);
}
