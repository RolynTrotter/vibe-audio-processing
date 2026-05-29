# Vibe Convolver

Mix **two audio files into one** by convolving them — right in the browser, on
any device including Android phones. Pick file A and file B, choose an effect,
and get a new WAV back. Nothing is uploaded; all the DSP runs locally on your
device, and the app installs to your home screen as a PWA so it works offline.

## What "convolving" does here

Two flavours, switchable in the UI:

- **Spectral cross-synthesis** *(default — the Max MSP `pfft~` approach)*
  Both files are chopped into overlapping **Hann-windowed** chunks, each chunk
  is run through an **FFT**, the two spectra are **multiplied**, the result is
  inverse-FFT'd, and the chunks are **overlap-added** back together. The result
  is time-varying: file A takes on the evolving timbre of file B. The shorter
  file is looped so it covers the longer one. FFT window (1024 / 2048 / 4096)
  and window overlap (2× / 4× / 8×) are selectable.

  Each chunk is **zero-padded before the FFT** so the spectral multiply is a
  *linear* convolution per block, not a circular one. This matters: a circular
  multiply wraps each block's tail back onto its start, and that discontinuity
  is the broadband "scratch" you'd otherwise hear (and the lone spikes that make
  normalization crush the rest of a file to silence). The Hann windowing
  amplitude is divided back out exactly via the overlap-added window
  autocorrelation, so windows add no warble — only the intended,
  signal-dependent level variation remains.

- **True convolution** *(convolution reverb)*
  A full linear convolution of the whole signals via a single zero-padded FFT.
  This treats **B as one fixed impulse response**, so it only sounds like
  "reverb" when B *is* an impulse response — a short room recording, a clap, a
  snare. With a long, evolving B it smears rather than tracks; for that, use
  cross-synthesis instead.

Either way, the **entire output is scanned for its peak and turned down** so it
can never clip — your PM's "no peeking" requirement. Output is mono WAV;
mismatched sample rates are matched automatically (resampled to the higher of
the two).

## Use it

1. Open the app (locally or the deployed GitHub Pages URL).
2. Tap **A** and **B** to choose two audio files (WAV recommended; other
   formats are decoded via the browser's audio engine as a fallback).
3. Pick the **Effect**, **FFT window**, and **Output ceiling**.
4. Hit **Convolve**, then play the result and **Download WAV**.

### On Android

Open the deployed URL in Chrome, then **menu → Add to Home screen**. It installs
like a native app and runs offline. Because all processing is on-device, files
never leave the phone.

## Run locally

No build step and no runtime dependencies — it's plain ES modules. You just need
a static file server (ES module workers don't load from `file://`):

```bash
# any static server works; e.g. with Node installed:
npx serve .
# or
python3 -m http.server 8000
```

Then open the served URL.

## Develop

```bash
npm test                 # run the DSP unit tests (Node's built-in runner)
npm run icons            # regenerate the PWA icons (pure Node, no deps)
```

### Project layout

```
index.html               # UI
src/styles.css           # styles
src/app.js               # UI wiring, file I/O, worker dispatch, PWA registration
src/worker.js            # off-main-thread processing
src/dsp/fft.js           # radix-2 FFT (dependency-free)
src/dsp/wav.js           # WAV decode/encode
src/dsp/convolve.js      # both algorithms + resample / mono / normalize
test/dsp.test.mjs        # unit tests (run in CI and locally with the same code)
scripts/generate-icons.mjs
sw.js                    # service worker (offline cache)
manifest.webmanifest     # PWA manifest
.github/workflows/       # ci.yml (tests), deploy.yml (GitHub Pages)
```

The exact DSP code that runs in the browser is what the tests exercise in Node —
there's no separate implementation to drift out of sync.

## Deploy

Merging to `main` triggers `.github/workflows/deploy.yml`, which publishes the
static app to **GitHub Pages**. One-time setup: in the repo, go to
**Settings → Pages → Build and deployment → Source: GitHub Actions**. After the
first deploy the app is live at `https://<user>.github.io/vibe-audio-processing/`.

## License

MIT — see [LICENSE](LICENSE).
