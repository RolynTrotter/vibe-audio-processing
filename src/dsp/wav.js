// Minimal but robust WAV (RIFF/WAVE) decoder and encoder.
//
// Decodes PCM integer (8/16/24/32-bit) and IEEE float (32/64-bit) WAV files
// into planar Float32 channels in the range [-1, 1]. Encodes back to 16-bit
// PCM (most compatible) or 32-bit float. Pure JS: works in browser, worker
// and Node alike, which lets the unit tests exercise the exact decode path
// the app uses.

const FMT_PCM = 1;
const FMT_FLOAT = 3;
const FMT_EXTENSIBLE = 0xfffe;

/**
 * Decode a WAV file.
 * @param {ArrayBuffer} buffer
 * @returns {{sampleRate:number, channels:Float32Array[], length:number}}
 */
export function decodeWav(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12) throw new Error('Not a WAV file (too small)');
  if (str(view, 0, 4) !== 'RIFF') throw new Error('Not a RIFF file');
  if (str(view, 8, 4) !== 'WAVE') throw new Error('Not a WAVE file');

  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;

  // Walk the chunk list rather than assuming a fixed layout.
  let pos = 12;
  while (pos + 8 <= buffer.byteLength) {
    const id = str(view, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      let audioFormat = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE stores the real format tag in the sub-format.
      if (audioFormat === FMT_EXTENSIBLE && size >= 24) {
        audioFormat = view.getUint16(body + 24, true);
      }
      fmt = { audioFormat, channels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      dataOffset = body;
      // Some files write 0 / 0xffffffff for streamed data; clamp to file.
      dataLength = Math.min(size, buffer.byteLength - body);
    }
    // Chunks are word-aligned (padded to even length).
    pos = body + size + (size & 1);
  }

  if (!fmt) throw new Error('WAV missing fmt chunk');
  if (dataOffset < 0) throw new Error('WAV missing data chunk');

  const { audioFormat, channels, bitsPerSample, sampleRate } = fmt;
  if (channels < 1) throw new Error('WAV has no channels');

  const bytesPerSample = bitsPerSample >> 3;
  const frameSize = bytesPerSample * channels;
  if (frameSize <= 0) throw new Error('Invalid WAV frame size');
  const frames = Math.floor(dataLength / frameSize);

  const out = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));

  const readSample = sampleReader(view, audioFormat, bitsPerSample);

  for (let f = 0; f < frames; f++) {
    const base = dataOffset + f * frameSize;
    for (let c = 0; c < channels; c++) {
      out[c][f] = readSample(base + c * bytesPerSample);
    }
  }

  return { sampleRate, channels: out, length: frames };
}

function sampleReader(view, audioFormat, bits) {
  if (audioFormat === FMT_FLOAT) {
    if (bits === 32) return (o) => view.getFloat32(o, true);
    if (bits === 64) return (o) => view.getFloat64(o, true);
    throw new Error(`Unsupported float bit depth: ${bits}`);
  }
  if (audioFormat === FMT_PCM) {
    if (bits === 8) {
      // 8-bit PCM is unsigned, centered at 128.
      return (o) => (view.getUint8(o) - 128) / 128;
    }
    if (bits === 16) {
      return (o) => view.getInt16(o, true) / 32768;
    }
    if (bits === 24) {
      return (o) => {
        const b0 = view.getUint8(o);
        const b1 = view.getUint8(o + 1);
        const b2 = view.getUint8(o + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v |= ~0xffffff; // sign-extend
        return v / 8388608;
      };
    }
    if (bits === 32) {
      return (o) => view.getInt32(o, true) / 2147483648;
    }
    throw new Error(`Unsupported PCM bit depth: ${bits}`);
  }
  throw new Error(`Unsupported WAV audio format: ${audioFormat}`);
}

/**
 * Encode planar Float32 channels to a WAV ArrayBuffer.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{bitDepth?: 16|32, float?: boolean}} [opts]
 * @returns {ArrayBuffer}
 */
export function encodeWav(channels, sampleRate, opts = {}) {
  const float = opts.float === true;
  const bitDepth = float ? 32 : (opts.bitDepth || 16);
  if (!float && bitDepth !== 16) throw new Error('Only 16-bit PCM or 32-bit float output supported');
  const numChannels = channels.length;
  if (numChannels < 1) throw new Error('encodeWav requires at least one channel');
  const frames = channels[0].length;
  const bytesPerSample = bitDepth >> 3;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, float ? FMT_FLOAT : FMT_PCM, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let off = 44;
  if (float) {
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < numChannels; c++) {
        view.setFloat32(off, channels[c][f], true);
        off += 4;
      }
    }
  } else {
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < numChannels; c++) {
        let s = channels[c][f];
        s = Math.max(-1, Math.min(1, s));
        // Symmetric rounding to 16-bit.
        view.setInt16(off, s < 0 ? s * 32768 : s * 32767, true);
        off += 2;
      }
    }
  }

  return buffer;
}

function str(view, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

function writeStr(view, offset, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
