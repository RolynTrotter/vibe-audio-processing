// Iterative in-place radix-2 Cooley-Tukey FFT.
//
// Operates on a pair of equal-length Float64Array buffers (real + imaginary)
// whose length must be a power of two. Dependency-free so the identical code
// runs in the browser, in a Web Worker, and under Node for the test suite.

/** Returns the smallest power of two >= n. */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** True if n is a positive power of two. */
export function isPow2(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

function transform(re, im, inverse) {
  const n = re.length;
  if (n !== im.length) throw new Error('re/im length mismatch');
  if (n <= 1) return;
  if (!isPow2(n)) throw new Error(`FFT length must be a power of two, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  // Butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cwr - im[b] * cwi;
        const xi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = ncwr;
      }
    }
  }
}

/** Forward FFT, in place. */
export function fft(re, im) {
  transform(re, im, false);
}

/** Inverse FFT, in place, normalized by 1/n. */
export function ifft(re, im) {
  transform(re, im, true);
  const n = re.length;
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] /= n;
  }
}
