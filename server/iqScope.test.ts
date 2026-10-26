// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildIqSpectrumFrame,
  IQ_FFT_SIZE,
  IQ_ENCODE_MIN_DB,
  IQ_ENCODE_MAX_DB,
  createIqBalanceState,
  updateIqBalance,
  describeIqBalance,
  applyIqBalance,
  iqBalanceAlpha,
  type IqBalanceState,
} from './iqScope.ts';
import { fftComplex, hannWindow } from './fft.ts';

const SAMPLE_RATE = 48000;
const CENTER_FREQ = 14074000;
// 48000/2048 = 23.4375 Hz/bin exactly, and 6000/23.4375 = 256 exactly — an
// offset that lands precisely on a bin, avoiding rounding ambiguity in the
// peak-bin assertions below.
const OFFSET_HZ = 6000;
const K0 = (OFFSET_HZ * IQ_FFT_SIZE) / SAMPLE_RATE;

const window = hannWindow(IQ_FFT_SIZE);

function preShiftToPostShift(k: number, n: number): number {
  return (((k - n / 2) % n) + n) % n;
}

/**
 * Interleaved 16-bit stereo PCM for a complex tone at bin `k0`: I=cos, Q=sin
 * (positive frequency). Default amplitude is deliberately low (representative
 * of the G90's low-level analog I/Q output, not a full-scale digital tone) so
 * the Hann-windowed peak (~A*fftSize/2 in magnitude) stays within
 * IQ_ENCODE_MAX_DB headroom — a peak that saturates the encode range clips
 * several neighboring sidelobe bins to the same byte value, making "which
 * bin is the max" an arbitrary tie-break rather than a meaningful assertion.
 */
function complexTonePcm(k0: number, amplitude = 0.01): Buffer {
  const buf = Buffer.alloc(IQ_FFT_SIZE * 4);
  for (let i = 0; i < IQ_FFT_SIZE; i++) {
    const phase = (2 * Math.PI * k0 * i) / IQ_FFT_SIZE;
    const iSample = Math.round(amplitude * 32767 * Math.cos(phase));
    const qSample = Math.round(amplitude * 32767 * Math.sin(phase));
    buf.writeInt16LE(iSample, i * 4);
    buf.writeInt16LE(qSample, i * 4 + 2);
  }
  return buf;
}

function peakIndex(amplitudes: number[]): number {
  let best = 0;
  for (let i = 1; i < amplitudes.length; i++) {
    if (amplitudes[i] > amplitudes[best]) best = i;
  }
  return best;
}

describe('buildIqSpectrumFrame', () => {
  it('rejects a PCM buffer of the wrong length', () => {
    expect(() =>
      buildIqSpectrumFrame({
        pcm: Buffer.alloc(10),
        fftSize: IQ_FFT_SIZE,
        sampleRate: SAMPLE_RATE,
        centerFreq: CENTER_FREQ,
        swapChannels: false,
        window,
      }),
    ).toThrow();
  });

  it('places a known-offset complex tone at the expected shifted bin', () => {
    const pcm = complexTonePcm(K0);
    const frame = buildIqSpectrumFrame({
      pcm,
      fftSize: IQ_FFT_SIZE,
      sampleRate: SAMPLE_RATE,
      centerFreq: CENTER_FREQ,
      swapChannels: false,
      window,
    });
    const expectedIdx = preShiftToPostShift(K0, IQ_FFT_SIZE);
    expect(peakIndex(frame.amplitudes)).toBe(expectedIdx);
  });

  it('swapChannels mirrors the peak to the opposite side of center (HDSDR-style Swap IQ)', () => {
    const pcm = complexTonePcm(K0);
    const normal = buildIqSpectrumFrame({
      pcm,
      fftSize: IQ_FFT_SIZE,
      sampleRate: SAMPLE_RATE,
      centerFreq: CENTER_FREQ,
      swapChannels: false,
      window,
    });
    const swapped = buildIqSpectrumFrame({
      pcm,
      fftSize: IQ_FFT_SIZE,
      sampleRate: SAMPLE_RATE,
      centerFreq: CENTER_FREQ,
      swapChannels: true,
      window,
    });
    const normalIdx = peakIndex(normal.amplitudes);
    const swappedIdx = peakIndex(swapped.amplitudes);
    const center = IQ_FFT_SIZE / 2;
    expect(swappedIdx).not.toBe(normalIdx);
    // Both peaks should be equidistant from the center (DC) bin, on opposite sides.
    expect(swappedIdx - center).toBe(-(normalIdx - center));
  });

  it('derives span/lowFreq/highFreq from sampleRate and centerFreq', () => {
    const pcm = complexTonePcm(0);
    const frame = buildIqSpectrumFrame({
      pcm,
      fftSize: IQ_FFT_SIZE,
      sampleRate: SAMPLE_RATE,
      centerFreq: CENTER_FREQ,
      swapChannels: false,
      window,
    });
    expect(frame.span).toBe(SAMPLE_RATE);
    expect(frame.lowFreq).toBe(CENTER_FREQ - SAMPLE_RATE / 2);
    expect(frame.highFreq).toBe(CENTER_FREQ + SAMPLE_RATE / 2);
    expect(frame.name).toBe('Audio I/Q');
    expect(frame.minLevel).toBe(IQ_ENCODE_MIN_DB);
    expect(frame.maxLevel).toBe(IQ_ENCODE_MAX_DB);
    expect(frame.length).toBe(IQ_FFT_SIZE);
    expect(frame.amplitudes.length).toBe(IQ_FFT_SIZE);
  });

  it('keeps every amplitude byte within [0,255]', () => {
    const pcm = complexTonePcm(K0, 1.0);
    const frame = buildIqSpectrumFrame({
      pcm,
      fftSize: IQ_FFT_SIZE,
      sampleRate: SAMPLE_RATE,
      centerFreq: CENTER_FREQ,
      swapChannels: false,
      window,
    });
    for (const a of frame.amplitudes) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(255);
    }
  });

  it('removes per-block DC offset instead of showing it as a center-bin spike', () => {
    // Constant (0 Hz) bias on both channels, no AC content at all — without
    // DC removal this would transform into a strong, spurious peak at the
    // center (DC) bin after fftShift.
    const biasedPcm = Buffer.alloc(IQ_FFT_SIZE * 4);
    const bias = Math.round(0.3 * 32767);
    for (let i = 0; i < IQ_FFT_SIZE; i++) {
      biasedPcm.writeInt16LE(bias, i * 4);
      biasedPcm.writeInt16LE(bias, i * 4 + 2);
    }
    const frame = buildIqSpectrumFrame({
      pcm: biasedPcm,
      fftSize: IQ_FFT_SIZE,
      sampleRate: SAMPLE_RATE,
      centerFreq: CENTER_FREQ,
      swapChannels: false,
      window,
    });
    const center = IQ_FFT_SIZE / 2;
    // The center bin should be quantized to (at most) the floor byte, not a
    // spike — every other bin should be no louder than it.
    for (const a of frame.amplitudes) {
      expect(a).toBeLessThanOrEqual(frame.amplitudes[center]);
    }
  });

  it('produces a much quieter peak for silence than for a tone', () => {
    const silence = Buffer.alloc(IQ_FFT_SIZE * 4);
    const silentFrame = buildIqSpectrumFrame({
      pcm: silence,
      fftSize: IQ_FFT_SIZE,
      sampleRate: SAMPLE_RATE,
      centerFreq: CENTER_FREQ,
      swapChannels: false,
      window,
    });
    const toneFrame = buildIqSpectrumFrame({
      pcm: complexTonePcm(K0),
      fftSize: IQ_FFT_SIZE,
      sampleRate: SAMPLE_RATE,
      centerFreq: CENTER_FREQ,
      swapChannels: false,
      window,
    });
    expect(Math.max(...toneFrame.amplitudes)).toBeGreaterThan(Math.max(...silentFrame.amplitudes));
  });
});

// ---------------------------------------------------------------------------
// Auto I/Q balance
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

/**
 * DC-free float I/Q for a complex tone at bin `k0` with a known receiver
 * imbalance applied: I = A*cos(theta), Q = A*g*sin(theta + phi) — the same
 * model iqScope.ts's estimator inverts (Q = g*(b*cos(phi) + a*sin(phi))).
 */
function imbalancedTone(k0: number, gainDb: number, phaseDeg: number, amplitude = 0.01): { i: Float64Array; q: Float64Array } {
  const g = Math.pow(10, gainDb / 20);
  const phi = phaseDeg * DEG;
  const i = new Float64Array(IQ_FFT_SIZE);
  const q = new Float64Array(IQ_FFT_SIZE);
  for (let n = 0; n < IQ_FFT_SIZE; n++) {
    const theta = (2 * Math.PI * k0 * n) / IQ_FFT_SIZE;
    i[n] = amplitude * Math.cos(theta);
    q[n] = amplitude * g * Math.sin(theta + phi);
  }
  return { i, q };
}

function toPcm(i: Float64Array, q: Float64Array): Buffer {
  const buf = Buffer.alloc(i.length * 4);
  for (let n = 0; n < i.length; n++) {
    buf.writeInt16LE(Math.round(i[n] * 32767), n * 4);
    buf.writeInt16LE(Math.round(q[n] * 32767), n * 4 + 2);
  }
  return buf;
}

/** Signal-to-mirror-image power ratio (dB) of a complex tone at +k0. */
function imageRejectionDb(i: Float64Array, q: Float64Array, k0: number): number {
  const re = Float64Array.from(i, (v, n) => v * window[n]);
  const im = Float64Array.from(q, (v, n) => v * window[n]);
  fftComplex(re, im);
  const pow = (k: number) => re[k] * re[k] + im[k] * im[k];
  return 10 * Math.log10(pow(k0) / pow(IQ_FFT_SIZE - k0));
}

/** Deterministic complex Gaussian noise (mulberry32 + Box-Muller), standing in for band noise. */
function noiseBlock(seed: number, gainDb: number, phaseDeg: number, sigma = 0.05): { i: Float64Array; q: Float64Array } {
  let t = seed >>> 0;
  const rand = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const g = Math.pow(10, gainDb / 20);
  const phi = phaseDeg * DEG;
  const i = new Float64Array(IQ_FFT_SIZE);
  const q = new Float64Array(IQ_FFT_SIZE);
  for (let n = 0; n < IQ_FFT_SIZE; n++) {
    const a = sigma * gauss();
    const b = sigma * gauss();
    i[n] = a;
    q[n] = g * (b * Math.cos(phi) + a * Math.sin(phi));
  }
  return { i, q };
}

function seeded(i: Float64Array, q: Float64Array): IqBalanceState {
  const state = createIqBalanceState();
  updateIqBalance(state, i, q, 1);
  return state;
}

describe('auto I/Q balance', () => {
  it('recovers a known gain/phase imbalance from a complex tone', () => {
    const { i, q } = imbalancedTone(K0, 1.5, 4);
    const est = describeIqBalance(seeded(i, q));
    expect(est.gainDb).toBeCloseTo(1.5, 2);
    expect(est.phaseDeg).toBeCloseTo(4, 2);
    expect(est.valid).toBe(true);
    expect(est.warning).toBeNull();
  });

  it('converges on a known imbalance from noise-like band content across smoothed blocks', () => {
    const state = createIqBalanceState();
    const alpha = iqBalanceAlpha(IQ_FFT_SIZE, SAMPLE_RATE);
    for (let b = 0; b < 200; b++) {
      const { i, q } = noiseBlock(b + 1, -0.8, -2.5);
      updateIqBalance(state, i, q, alpha);
    }
    const est = describeIqBalance(state);
    // The 1 s smoothing window averages ~95k samples (EMA effective length
    // ~(2/alpha - 1) blocks), so the estimate's own statistical jitter is
    // ~1/sqrt(95k) rad ≈ 0.2° (1 sigma) — these bounds are ~3 sigma, not a
    // tighter precision than the estimator can deliver on noise.
    expect(Math.abs(est.gainDb - -0.8)).toBeLessThan(0.1);
    expect(Math.abs(est.phaseDeg - -2.5)).toBeLessThan(0.6);
  });

  it('reports the uncorrected image rejection implied by the measured imbalance', () => {
    const { i, q } = imbalancedTone(K0, 1, 3);
    const est = describeIqBalance(seeded(i, q));
    // Same quantity measured directly off the FFT: the mirror image's actual level.
    expect(est.imageRejectionDb).toBeCloseTo(imageRejectionDb(i, q, K0), 0);
  });

  it('removes the mirror image of an imbalanced tone', () => {
    const { i, q } = imbalancedTone(K0, 1, 3);
    const before = imageRejectionDb(i, q, K0);
    const state = seeded(i, q);
    expect(applyIqBalance(state, i, q)).toBe(true);
    const after = imageRejectionDb(i, q, K0);
    expect(before).toBeLessThan(30); // ~25 dB: a clearly visible mirror
    expect(after).toBeGreaterThan(80);
  });

  it('is effectively a no-op on an already-balanced pair', () => {
    const { i, q } = imbalancedTone(K0, 0, 0);
    const original = Float64Array.from(q);
    const state = seeded(i, q);
    const est = describeIqBalance(state);
    expect(est.gainDb).toBeCloseTo(0, 4);
    expect(est.phaseDeg).toBeCloseTo(0, 4);
    expect(Number.isFinite(est.imageRejectionDb)).toBe(true);
    applyIqBalance(state, i, q);
    for (let n = 0; n < q.length; n++) expect(q[n]).toBeCloseTo(original[n], 9);
  });

  it('refuses to correct, and warns, when one channel is silent', () => {
    const { i } = imbalancedTone(K0, 0, 0, 0.1);
    const q = new Float64Array(IQ_FFT_SIZE);
    const state = seeded(i, q);
    const est = describeIqBalance(state);
    expect(est.valid).toBe(false);
    expect(est.warning).toMatch(/silent/i);
    expect(applyIqBalance(state, i, q)).toBe(false);
    expect(q.every(v => v === 0)).toBe(true);
  });

  it('warns when both inputs carry the same signal', () => {
    const { i } = imbalancedTone(K0, 0, 0, 0.1);
    const est = describeIqBalance(seeded(i, Float64Array.from(i)));
    expect(est.valid).toBe(false);
    expect(est.warning).toMatch(/identical/i);
  });

  it('warns instead of correcting a level mismatch beyond the sanity bound', () => {
    const { i, q } = imbalancedTone(K0, 10, 0);
    const original = Float64Array.from(q);
    const state = seeded(i, q);
    expect(describeIqBalance(state).warning).toMatch(/mismatch/i);
    expect(applyIqBalance(state, i, q)).toBe(false);
    expect(q).toEqual(original);
  });

  it('reports no signal (rather than a wiring problem) when both channels are silent', () => {
    const silent = new Float64Array(IQ_FFT_SIZE);
    const est = describeIqBalance(seeded(silent, Float64Array.from(silent)));
    expect(est.valid).toBe(false);
    expect(est.warning).toMatch(/no i\/q signal/i);
  });

  it('has no estimate (and no warning) before the first block', () => {
    const est = describeIqBalance(createIqBalanceState());
    expect(est.valid).toBe(false);
    expect(est.warning).toBeNull();
  });

  it('keeps the smoothing time constant independent of sample rate', () => {
    // After 1 s worth of blocks, a step should reach 1 - 1/e at every rate.
    for (const rate of [48000, 96000, 192000]) {
      const alpha = iqBalanceAlpha(IQ_FFT_SIZE, rate);
      const blocksPerSecond = rate / IQ_FFT_SIZE;
      expect(1 - Math.pow(1 - alpha, blocksPerSecond)).toBeCloseTo(1 - 1 / Math.E, 6);
    }
  });

  describe('through buildIqSpectrumFrame', () => {
    const frameOpts = (pcm: Buffer) => ({
      pcm,
      fftSize: IQ_FFT_SIZE,
      sampleRate: SAMPLE_RATE,
      centerFreq: CENTER_FREQ,
      swapChannels: false,
      window,
    });
    const { i, q } = imbalancedTone(K0, 1, 3);
    const pcm = toPcm(i, q);
    const toneIdx = preShiftToPostShift(K0, IQ_FFT_SIZE);
    const imageIdx = preShiftToPostShift(IQ_FFT_SIZE - K0, IQ_FFT_SIZE);

    it('lowers the mirror-image bin when applied', () => {
      const plain = buildIqSpectrumFrame(frameOpts(pcm));
      const corrected = buildIqSpectrumFrame({
        ...frameOpts(pcm),
        balance: { state: createIqBalanceState(), alpha: 1, apply: true },
      });
      const bytesPerDb = 255 / (IQ_ENCODE_MAX_DB - IQ_ENCODE_MIN_DB);
      expect(peakIndex(corrected.amplitudes)).toBe(toneIdx);
      expect(plain.amplitudes[imageIdx] - corrected.amplitudes[imageIdx]).toBeGreaterThan(30 * bytesPerDb);
    });

    it('measures without changing the frame when not applied', () => {
      const state = createIqBalanceState();
      const plain = buildIqSpectrumFrame(frameOpts(pcm));
      const measured = buildIqSpectrumFrame({ ...frameOpts(pcm), balance: { state, alpha: 1, apply: false } });
      expect(measured.amplitudes).toEqual(plain.amplitudes);
      expect(describeIqBalance(state).gainDb).toBeCloseTo(1, 1);
    });
  });
});
