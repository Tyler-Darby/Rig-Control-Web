import type { ServerContext } from "./context.ts";
import { vlogSpectrum, createRateLogger } from "./vlog.ts";
import { resolveDeviceId } from "./audio.ts";
import { fftComplex, fftShift, hannWindow, magnitudesDb } from "./fft.ts";

// Non-overlapping block size for the complex FFT. 2048 balances frequency
// resolution against waterfall refresh rate across the supported sample
// rates (~23fps/23Hz-per-bin at 48kHz, ~47fps/47Hz-per-bin at 96kHz).
export const IQ_FFT_SIZE = 2048;

// Fixed dB range the raw FFT magnitude is quantized into before being sent
// as a 0-255 amplitude byte (SpectrumHamlibPanel's floor/ceiling sliders
// then pick a sub-window of this range for display, same as the other two
// sources). Not a calibrated dBm reference (no absolute level is known
// without real hardware) — real captured levels have turned out to run
// hotter than originally assumed for a low-level (~50-100mV) analog G90
// I/Q signal, which is why the panel's floor/ceiling sliders were widened;
// tune these bounds and the panel's floor/ceiling defaults further once
// verified against real equipment.
export const IQ_ENCODE_MIN_DB = -100;
export const IQ_ENCODE_MAX_DB = 20;

const FRAME_BYTES = IQ_FFT_SIZE * 4; // 2 channels * 2 bytes (16-bit signed PCM)
const ENGINE_RETRY_DELAY_MS = 500;
const ENGINE_RETRY_ATTEMPTS = 6;

const iqWindow = hannWindow(IQ_FFT_SIZE);

// Auto I/Q balance (spectrumSettings.iqAutoBalance). Blind, second-order
// moment estimator + Gram-Schmidt orthogonalization: with I as the reference,
// a gain/phase-imbalanced quadrature pair is modeled as
//   I = a,  Q = g * (b*cos(phi) + a*sin(phi))
// where the true baseband pair (a, b) is assumed proper (E[a^2] = E[b^2],
// E[ab] = 0) — true of ordinary band noise and of any complex tone averaged
// over many cycles. Then E[IQ]/E[I^2] = g*sin(phi) and E[Q^2]/E[I^2] = g^2,
// so subtracting the I-correlated part of Q and rescaling the remainder to
// I's power recovers b exactly. Same signal model and correction structure
// as Moseley & Slump, "A low-complexity feed-forward I/Q imbalance
// compensation algorithm" (2006) — which estimates the same quantities from
// cheaper sign-based statistics for microcontrollers; plain second-order
// moments are affordable here. It corrects one frequency-independent
// gain/phase error, the power-weighted average across the span.
// Frequency-dependent mismatch (component tolerances in each path's
// filters) is not corrected.
//
// The moments are exponentially smoothed across blocks so the estimate is
// stable against per-block noise; the time constant is in seconds so it's
// the same at every capture sample rate.
export const IQ_BALANCE_TIME_CONSTANT_S = 1;
// Sanity bounds: a real radio + sound card stays well inside these. Anything
// outside means the wiring is wrong (one channel silent, both inputs fed the
// same signal, a balanced TRS input subtracting I and Q, ...) — correcting
// it blindly would just amplify noise into a plausible-looking but wrong
// display, so correction is skipped and a warning is surfaced instead.
export const IQ_BALANCE_MAX_GAIN_DB = 6;
export const IQ_BALANCE_MAX_PHASE_DEG = 30;
// Below this per-channel power (~-80 dBFS RMS) a channel is treated as silent.
const IQ_BALANCE_SILENT_POWER = 1e-8;
// Silent-channel threshold for the gain-mismatch message (vs. a merely
// out-of-range imbalance).
const IQ_BALANCE_SILENT_GAIN_DB = 20;
const IQ_BALANCE_STATUS_INTERVAL_MS = 1000;
// Keeps every reported dB value finite (JSON has no Infinity — it would
// arrive at the client as null).
const IQ_BALANCE_DB_LIMIT = 99;

function clampDb(db: number): number {
  return Math.max(-IQ_BALANCE_DB_LIMIT, Math.min(IQ_BALANCE_DB_LIMIT, db));
}

/** Smoothed second-order moments of the (DC-removed, post-swap) I/Q pair. */
export interface IqBalanceState {
  pII: number;
  pQQ: number;
  pIQ: number;
  initialized: boolean;
}

export interface IqBalanceEstimate {
  /** Q level relative to I, in dB (0 = matched). */
  gainDb: number;
  /** Deviation from 90° between I and Q, in degrees (0 = perfect quadrature). */
  phaseDeg: number;
  /** Uncorrected image rejection implied by gainDb/phaseDeg, in dB. */
  imageRejectionDb: number;
  /** Whether the estimate is within the bounds where correction is applied. */
  valid: boolean;
  /** Human-readable wiring/level problem when !valid, else null. */
  warning: string | null;
}

export function createIqBalanceState(): IqBalanceState {
  return { pII: 0, pQQ: 0, pIQ: 0, initialized: false };
}

/** Coefficient for exponential smoothing of one FFT block's moments. */
export function iqBalanceAlpha(fftSize: number, sampleRate: number, timeConstantS = IQ_BALANCE_TIME_CONSTANT_S): number {
  return 1 - Math.exp(-(fftSize / sampleRate) / timeConstantS);
}

/**
 * Folds one block's moments into `state` (mutated in place). `i`/`q` must
 * already be DC-removed. The first block seeds the state directly rather
 * than ramping up from zero.
 */
export function updateIqBalance(state: IqBalanceState, i: Float64Array, q: Float64Array, alpha: number): void {
  const n = i.length;
  let sII = 0;
  let sQQ = 0;
  let sIQ = 0;
  for (let k = 0; k < n; k++) {
    sII += i[k] * i[k];
    sQQ += q[k] * q[k];
    sIQ += i[k] * q[k];
  }
  sII /= n;
  sQQ /= n;
  sIQ /= n;
  if (!state.initialized) {
    state.pII = sII;
    state.pQQ = sQQ;
    state.pIQ = sIQ;
    state.initialized = true;
    return;
  }
  state.pII += alpha * (sII - state.pII);
  state.pQQ += alpha * (sQQ - state.pQQ);
  state.pIQ += alpha * (sIQ - state.pIQ);
}

export function describeIqBalance(state: IqBalanceState): IqBalanceEstimate {
  const { pII, pQQ, pIQ } = state;
  if (!state.initialized || pII < IQ_BALANCE_SILENT_POWER || pQQ < IQ_BALANCE_SILENT_POWER) {
    const bothSilent = pII < IQ_BALANCE_SILENT_POWER && pQQ < IQ_BALANCE_SILENT_POWER;
    return {
      gainDb: state.initialized && pII > 0 && pQQ > 0 ? clampDb(10 * Math.log10(pQQ / pII)) : 0,
      phaseDeg: 0,
      imageRejectionDb: 0,
      valid: false,
      warning: !state.initialized
        ? null
        : bothSilent
          ? "No I/Q signal — check the radio's I/Q output and the selected capture device"
          : "One I/Q channel is silent — check that I and Q go to separate inputs",
    };
  }

  const g = Math.sqrt(pQQ / pII);
  const sinPhi = Math.max(-1, Math.min(1, pIQ / Math.sqrt(pII * pQQ)));
  const phi = Math.asin(sinPhi);
  const gainDb = 20 * Math.log10(g);
  const phaseDeg = (phi * 180) / Math.PI;
  // Image rejection ratio of an uncorrected receiver with gain ratio g and
  // phase error phi: (1 + 2g*cos(phi) + g^2) / (1 - 2g*cos(phi) + g^2).
  const num = 1 + 2 * g * Math.cos(phi) + g * g;
  const den = 1 - 2 * g * Math.cos(phi) + g * g;
  const imageRejectionDb = den > 1e-12 ? clampDb(10 * Math.log10(num / den)) : IQ_BALANCE_DB_LIMIT;

  let warning: string | null = null;
  if (Math.abs(gainDb) > IQ_BALANCE_SILENT_GAIN_DB) {
    warning = "One I/Q channel is far weaker than the other — check that I and Q go to separate inputs";
  } else if (Math.abs(phaseDeg) > IQ_BALANCE_MAX_PHASE_DEG) {
    warning = "I and Q are nearly identical — check that they go to separate inputs (not one balanced/TRS input)";
  } else if (Math.abs(gainDb) > IQ_BALANCE_MAX_GAIN_DB) {
    warning = `I/Q level mismatch over ${IQ_BALANCE_MAX_GAIN_DB} dB — match the input gains more closely`;
  }

  return { gainDb, phaseDeg, imageRejectionDb, valid: warning === null, warning };
}

/**
 * Corrects `q` in place against `i` using the smoothed estimate in `state`
 * (Gram-Schmidt: remove Q's I-correlated part, rescale to I's power).
 * Returns false (leaving `q` untouched) when the estimate is outside the
 * sanity bounds — see describeIqBalance().
 */
export function applyIqBalance(state: IqBalanceState, i: Float64Array, q: Float64Array): boolean {
  if (!describeIqBalance(state).valid) return false;
  const { pII, pQQ, pIQ } = state;
  const k = pIQ / pII;
  const orthPower = pQQ - (pIQ * pIQ) / pII;
  if (orthPower <= 0) return false;
  const scale = Math.sqrt(pII / orthPower);
  for (let n = 0; n < q.length; n++) {
    q[n] = (q[n] - k * i[n]) * scale;
  }
  return true;
}

export interface IqBalanceOptions {
  /** Smoothed moment state, mutated in place by every frame. */
  state: IqBalanceState;
  /** Per-block smoothing coefficient — see iqBalanceAlpha(). */
  alpha: number;
  /** Apply the correction (true) or only measure (false). */
  apply: boolean;
}

export interface IqSpectrumFrameOptions {
  /** Interleaved 16-bit signed PCM, exactly `fftSize * 4` bytes (2 channels). */
  pcm: Buffer;
  fftSize: number;
  sampleRate: number;
  centerFreq: number;
  swapChannels: boolean;
  window: Float64Array;
  /**
   * Optional auto I/Q balance. Always measures when present (for the
   * settings readout); only corrects when `apply` is set. Omitted = the
   * original, uncorrected transform.
   */
  balance?: IqBalanceOptions;
}

export interface IqSpectrumFrame {
  id: number;
  name: string;
  type: "CENTER";
  length: number;
  amplitudes: number[];
  minLevel: number;
  maxLevel: number;
  centerFreq: number;
  span: number;
  lowFreq: number;
  highFreq: number;
  timestamp: number;
}

/**
 * Pure transform: interleaved stereo PCM -> a spectrum-data-shaped frame.
 * Left/right channels are treated as I/Q (swappable via `swapChannels`,
 * mirroring HDSDR's own "Swap IQ" fix for reversed-sideband I/Q sources).
 * Kept dependency-free (no naudiodon) so it's unit-testable without real
 * hardware.
 *
 * Removes each block's own I/Q DC offset (mean) before windowing — cheap USB
 * audio ADCs carry a per-channel DC bias, which is indistinguishable from a
 * real signal at 0 Hz and otherwise shows up as a strong, spurious spike at
 * the center (DC) bin after fftShift.
 *
 * With `balance` set, the DC-removed pair also feeds the auto I/Q balance
 * estimator (whose state object is the one deliberate side effect here) and,
 * if `balance.apply`, is gain/phase-corrected before windowing.
 */
export function buildIqSpectrumFrame(opts: IqSpectrumFrameOptions): IqSpectrumFrame {
  const { pcm, fftSize, sampleRate, centerFreq, swapChannels, window, balance } = opts;
  if (pcm.length !== fftSize * 4) {
    throw new Error(`buildIqSpectrumFrame: expected ${fftSize * 4} bytes, got ${pcm.length}`);
  }

  const iSamples = new Float64Array(fftSize);
  const qSamples = new Float64Array(fftSize);
  let sumI = 0;
  let sumQ = 0;
  for (let i = 0; i < fftSize; i++) {
    const chA = pcm.readInt16LE(i * 4) / 32768;
    const chB = pcm.readInt16LE(i * 4 + 2) / 32768;
    const iSample = swapChannels ? chB : chA;
    const qSample = swapChannels ? chA : chB;
    iSamples[i] = iSample;
    qSamples[i] = qSample;
    sumI += iSample;
    sumQ += qSample;
  }
  const meanI = sumI / fftSize;
  const meanQ = sumQ / fftSize;
  for (let i = 0; i < fftSize; i++) {
    iSamples[i] -= meanI;
    qSamples[i] -= meanQ;
  }

  if (balance) {
    updateIqBalance(balance.state, iSamples, qSamples, balance.alpha);
    if (balance.apply) applyIqBalance(balance.state, iSamples, qSamples);
  }

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const w = window[i];
    re[i] = iSamples[i] * w;
    im[i] = qSamples[i] * w;
  }

  fftComplex(re, im);
  const dbValues = fftShift(magnitudesDb(re, im, IQ_ENCODE_MIN_DB));

  const range = IQ_ENCODE_MAX_DB - IQ_ENCODE_MIN_DB;
  const amplitudes: number[] = new Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const norm = Math.max(0, Math.min(1, (dbValues[i] - IQ_ENCODE_MIN_DB) / range));
    amplitudes[i] = Math.round(norm * 255);
  }

  return {
    id: 0,
    name: "Audio I/Q",
    type: "CENTER",
    length: fftSize,
    amplitudes,
    minLevel: IQ_ENCODE_MIN_DB,
    maxLevel: IQ_ENCODE_MAX_DB,
    centerFreq,
    span: sampleRate,
    lowFreq: centerFreq - sampleRate / 2,
    highFreq: centerFreq + sampleRate / 2,
    timestamp: Date.now(),
  };
}

function emitStatus(ctx: ServerContext, running: boolean, error: string | null): void {
  ctx.iqScopeRunning = running;
  ctx.iqScopeError = error;
  ctx.io.emit("iq-scope-status", { running, error });
  // No capture, no measurement — clears the settings readout.
  if (!running) ctx.io.emit("iq-balance-status", null);
}

/**
 * Opens a stereo naudiodon capture stream against the configured I/Q device
 * and streams `spectrum-data` frames — no child binary involved (unlike the
 * FT4222 path), naudiodon is driven directly in-process, the same way
 * server/audio.ts's radio-audio capture is.
 */
export function startIqScope(ctx: ServerContext, attempt = 0): void {
  if (ctx.iqCaptureProcess) return; // already running

  if (!ctx.isAudioEngineReady || !ctx.portAudio) {
    // initAudioEngine(ctx) is fire-and-forget at server startup — it usually
    // resolves well under a second, so a short bounded retry covers the
    // startup-autostart race without a full FT4222-style retry budget.
    if (attempt >= ENGINE_RETRY_ATTEMPTS) {
      const msg = "Audio engine not ready (naudiodon failed to load)";
      console.error(`[IQ-SCOPE] ${msg}`);
      emitStatus(ctx, false, msg);
      return;
    }
    setTimeout(() => startIqScope(ctx, attempt + 1), ENGINE_RETRY_DELAY_MS);
    return;
  }

  if (!ctx.spectrumSettings.iqAudioDevice) {
    const msg = "No I/Q capture device selected";
    vlogSpectrum(`[IQ-SCOPE] ${msg}`);
    emitStatus(ctx, false, msg);
    return;
  }

  const sampleRate = ctx.spectrumSettings.iqSampleRate || 48000;

  let deviceId: number;
  try {
    deviceId = resolveDeviceId(ctx, ctx.spectrumSettings.iqAudioDevice, "input");
  } catch (err: any) {
    const msg = `Failed to resolve I/Q device: ${err.message}`;
    console.error(`[IQ-SCOPE] ${msg}`);
    emitStatus(ctx, false, msg);
    return;
  }

  if (deviceId < 0) {
    const msg = "Configured I/Q capture device not found";
    console.error(`[IQ-SCOPE] ${msg}`);
    emitStatus(ctx, false, msg);
    return;
  }

  vlogSpectrum(`[IQ-SCOPE] Starting capture: device=${deviceId} sampleRate=${sampleRate} fftSize=${IQ_FFT_SIZE}`);

  let proc: any;
  try {
    proc = new ctx.portAudio.AudioIO({
      inOptions: {
        channelCount: 2,
        sampleFormat: ctx.portAudio.SampleFormat16Bit,
        sampleRate,
        deviceId,
        closeOnError: true,
        framesPerBuffer: 0,
        maxQueue: 10,
        highwaterMark: 256,
      },
    });
  } catch (err: any) {
    const msg = `Failed to open I/Q capture device: ${err.message}`;
    console.error(`[IQ-SCOPE] ${msg}`);
    emitStatus(ctx, false, msg);
    return;
  }

  ctx.iqCaptureProcess = proc;
  let pcmBuffer = Buffer.alloc(0);
  let frameCount = 0;
  const rateLog = createRateLogger<IqSpectrumFrame>(1000, (count, elapsed, frame) => {
    const fps = Math.round(count / elapsed);
    const range = IQ_ENCODE_MAX_DB - IQ_ENCODE_MIN_DB;
    const toDb = (amp: number) => IQ_ENCODE_MIN_DB + (amp / 255) * range;
    const hzPerBin = sampleRate / IQ_FFT_SIZE;
    const centerIdx = IQ_FFT_SIZE / 2;
    let peakIdx = 0;
    for (let i = 1; i < frame.amplitudes.length; i++) {
      if (frame.amplitudes[i] > frame.amplitudes[peakIdx]) peakIdx = i;
    }
    const peakOffsetHz = Math.round((peakIdx - centerIdx) * hzPerBin);
    vlogSpectrum(
      `[IQ-SCOPE] ${fps} fps (${frameCount} total); ` +
      `center-bin=${toDb(frame.amplitudes[centerIdx]).toFixed(1)}dB; ` +
      `peak=${toDb(frame.amplitudes[peakIdx]).toFixed(1)}dB at ${peakOffsetHz >= 0 ? "+" : ""}${peakOffsetHz}Hz from center`
    );
  });

  // Per-capture balance estimate. Reset whenever Swap I/Q flips, since the
  // smoothed moments are relative to whichever channel is currently I.
  const balanceAlpha = iqBalanceAlpha(IQ_FFT_SIZE, sampleRate);
  let balanceState = createIqBalanceState();
  let balanceSwap = ctx.spectrumSettings.iqSwapChannels;
  const balanceStatusLog = createRateLogger<boolean>(IQ_BALANCE_STATUS_INTERVAL_MS, (_count, _elapsed, autoBalance) => {
    const estimate = describeIqBalance(balanceState);
    const applied = autoBalance && estimate.valid;
    ctx.io.emit("iq-balance-status", { ...estimate, applied });
    vlogSpectrum(
      `[IQ-SCOPE] balance: gain=${estimate.gainDb.toFixed(2)}dB phase=${estimate.phaseDeg.toFixed(2)}deg ` +
      `uncorrected-image-rejection=${estimate.imageRejectionDb.toFixed(1)}dB applied=${applied}` +
      (estimate.warning ? ` warning="${estimate.warning}"` : "")
    );
  });

  proc.on("data", (data: Buffer) => {
    try {
      pcmBuffer = Buffer.concat([pcmBuffer, data]);
      while (pcmBuffer.length >= FRAME_BYTES) {
        const block = pcmBuffer.subarray(0, FRAME_BYTES);
        pcmBuffer = pcmBuffer.subarray(FRAME_BYTES);
        const swapChannels = ctx.spectrumSettings.iqSwapChannels;
        if (swapChannels !== balanceSwap) {
          balanceState = createIqBalanceState();
          balanceSwap = swapChannels;
        }
        const autoBalance = ctx.spectrumSettings.iqAutoBalance;
        const frame = buildIqSpectrumFrame({
          pcm: block,
          fftSize: IQ_FFT_SIZE,
          sampleRate,
          centerFreq: Number(ctx.lastStatus.frequency) || 0,
          swapChannels,
          window: iqWindow,
          balance: { state: balanceState, alpha: balanceAlpha, apply: autoBalance },
        });
        ctx.io.emit("spectrum-data", frame);
        balanceStatusLog(autoBalance);

        // Once/sec diagnostic: are frames actually flowing, is the center
        // (DC) bin still hot, and where does the real peak/spur sit? Mirrors
        // server/yaesuScope.ts's throttled fps log. Amplitude bytes are
        // decoded back to dB via the same linear mapping buildIqSpectrumFrame
        // used to encode them (IQ_ENCODE_MIN_DB..IQ_ENCODE_MAX_DB).
        frameCount++;
        rateLog(frame);
      }
    } catch (err: any) {
      console.error("[IQ-SCOPE] Frame build error:", err.message);
    }
  });

  proc.on("error", (err: any) => {
    const msg = `naudiodon error: ${err.message}`;
    console.error(`[IQ-SCOPE] ${msg}`);
    ctx.iqCaptureProcess = null;
    emitStatus(ctx, false, msg);
  });

  proc.start();
  emitStatus(ctx, true, null);
}

export async function stopIqScope(ctx: ServerContext): Promise<void> {
  if (ctx.iqCaptureProcess) {
    try { await ctx.iqCaptureProcess.quit(); } catch { /* already stopped */ }
    ctx.iqCaptureProcess = null;
  }
  emitStatus(ctx, false, null);
}
