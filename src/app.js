// UI wiring for the convolver: file pickers, options, worker dispatch,
// in-browser preview and download. No build step — plain ES modules.

const $ = (id) => document.getElementById(id);

const fileA = $('fileA');
const fileB = $('fileB');
const dropA = $('dropA');
const dropB = $('dropB');
const nameA = $('nameA');
const nameB = $('nameB');
const modeSel = $('mode');
const frameSel = $('frameSize');
const frameRow = $('frameRow');
const overlapSel = $('overlap');
const overlapRow = $('overlapRow');
const normSel = $('normalize');
const goBtn = $('go');
const status = $('status');
const progress = $('progress');
const resultBox = $('result');
const player = $('player');
const downloadLink = $('download');

let pickedA = null;
let pickedB = null;
let worker = null;
let jobId = 0;
let lastUrl = null;

function makeWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}
makeWorker();

// --- file selection (click + drag/drop) ---------------------------------

function bindPicker(input, drop, label, set) {
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) {
      set(input.files[0]);
      label.textContent = input.files[0].name;
      drop.classList.add('filled');
    }
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) { set(f); label.textContent = f.name; drop.classList.add('filled'); }
  });
}

bindPicker(fileA, dropA, nameA, (f) => (pickedA = f));
bindPicker(fileB, dropB, nameB, (f) => (pickedB = f));

// Frame size and overlap only matter for cross-synthesis.
modeSel.addEventListener('change', () => {
  const show = modeSel.value === 'cross' ? '' : 'none';
  frameRow.style.display = show;
  overlapRow.style.display = show;
});

// --- decoding helpers ----------------------------------------------------

async function readArrayBuffer(file) {
  return await file.arrayBuffer();
}

// Fallback decode via Web Audio for files our WAV parser can't handle
// (non-WAV, exotic encodings). Returns planar Float32 channels.
async function decodeViaWebAudio(buffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData(buffer.slice(0));
    const channels = [];
    for (let c = 0; c < audio.numberOfChannels; c++) {
      channels.push(audio.getChannelData(c).slice());
    }
    return { sampleRate: audio.sampleRate, channels };
  } finally {
    ctx.close();
  }
}

// Try the worker's WAV path; if it fails, decode here and retry with PCM.
async function buildSource(file) {
  const buffer = await readArrayBuffer(file);
  // Quick sniff for RIFF/WAVE so we don't spin up Web Audio needlessly.
  const head = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength));
  const isWav = head.length >= 12 &&
    String.fromCharCode(head[0], head[1], head[2], head[3]) === 'RIFF' &&
    String.fromCharCode(head[8], head[9], head[10], head[11]) === 'WAVE';
  if (isWav) return { kind: 'buffer', payload: { buffer } };
  const decoded = await decodeViaWebAudio(buffer);
  return { kind: 'channels', payload: decoded };
}

// --- run -----------------------------------------------------------------

function setBusy(busy) {
  goBtn.disabled = busy;
  progress.style.display = busy ? '' : 'none';
}

function runWorker(a, b, opts) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    const onMsg = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', onMsg);
      if (e.data.ok) resolve(e.data);
      else reject(new Error(e.data.error));
    };
    worker.addEventListener('message', onMsg);

    const transfer = [];
    const pack = (src) => {
      if (src.kind === 'buffer') {
        transfer.push(src.payload.buffer);
        return src.payload;
      }
      src.payload.channels.forEach((c) => transfer.push(c.buffer));
      return src.payload;
    };
    worker.postMessage({ id, a: pack(a), b: pack(b), opts }, transfer);
  });
}

goBtn.addEventListener('click', async () => {
  if (!pickedA || !pickedB) {
    status.textContent = 'Pick two audio files first.';
    return;
  }
  setBusy(true);
  status.textContent = 'Decoding…';
  resultBox.style.display = 'none';

  try {
    const [a, b] = await Promise.all([buildSource(pickedA), buildSource(pickedB)]);
    status.textContent = 'Convolving…';
    const opts = {
      mode: modeSel.value,
      frameSize: parseInt(frameSel.value, 10),
      overlap: parseInt(overlapSel.value, 10),
      normalizeDb: parseFloat(normSel.value),
    };
    const res = await runWorker(a, b, opts);

    const blob = new Blob([res.wav], { type: 'audio/wav' });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);

    player.src = lastUrl;
    const base = `${stripExt(pickedA.name)}__x__${stripExt(pickedB.name)}`;
    downloadLink.href = lastUrl;
    downloadLink.download = `${base}.wav`;

    const secs = (res.frames / res.sampleRate).toFixed(2);
    status.textContent = `Done — ${secs}s @ ${res.sampleRate} Hz, peak-limited so it can't clip.`;
    resultBox.style.display = '';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    // A failed job can leave a module worker in a bad state; recreate it.
    try { worker.terminate(); } catch (_) {}
    makeWorker();
  } finally {
    setBusy(false);
  }
});

function stripExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

// --- PWA service worker --------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url))
      .catch((e) => console.warn('SW registration failed', e));
  });
}
