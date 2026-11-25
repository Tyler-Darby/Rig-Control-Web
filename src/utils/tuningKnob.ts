// Input math and CAT pacing for the VFO tuning knob (src/components/TuningKnob.tsx). Kept free of
// React/DOM so it can be unit-tested directly.

// ── Wheel / trackpad ─────────────────────────────────────────────────────────
//
// Browsers give no reliable way to tell a mouse wheel from a trackpad, and never expose the OS's
// momentum phase, so this is a heuristic built on the deltas alone:
//  - deltaMode line/page deltas are converted to pixels (Firefox can report lines).
//  - Pixel travel accumulates toward WHEEL_PX_PER_STEP, but one event is capped at one step, so a
//    big mouse-wheel notch or a huge trackpad flick delta can never jump several steps at once.
//  - An event arriving after a pause (a new gesture) always moves exactly one step immediately, so
//    a slow macOS mouse notch (as little as ~4 px) still tunes one step per click.
//  - Reversing direction discards the accumulated travel, so a stray opposite-sign blip (common
//    at the tail of Apple trackpad momentum) has to travel a full step before it counts.
//  - Steps are rate-limited; any excess is dropped rather than banked, so letting go of the
//    trackpad stops tuning instead of draining a backlog.
export const WHEEL_PX_PER_STEP = 40;
export const WHEEL_LINE_PX = 40;
export const WHEEL_PAGE_PX = 800;
export const WHEEL_GESTURE_GAP_MS = 100;
export const WHEEL_MIN_STEP_INTERVAL_MS = 30;

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export class WheelStepAccumulator {
  private acc = 0;
  private lastEventAt = -Infinity;
  private lastStepAt = -Infinity;

  /** Returns +1 (frequency up), -1 (down) or 0 for one wheel event. Scrolling up (deltaY < 0) tunes up. */
  push(deltaY: number, deltaMode: number, timeStamp: number): number {
    const px = deltaMode === DOM_DELTA_LINE ? deltaY * WHEEL_LINE_PX
      : deltaMode === DOM_DELTA_PAGE ? deltaY * WHEEL_PAGE_PX
      : deltaY;
    const isNewGesture = timeStamp - this.lastEventAt > WHEEL_GESTURE_GAP_MS;
    this.lastEventAt = timeStamp;
    if (px === 0) return 0;

    const travel = -px;
    let step = 0;
    if (isNewGesture) {
      this.acc = 0;
      step = Math.sign(travel);
    } else {
      if (Math.sign(travel) !== Math.sign(this.acc)) this.acc = 0;
      this.acc += Math.max(-WHEEL_PX_PER_STEP, Math.min(WHEEL_PX_PER_STEP, travel));
      if (Math.abs(this.acc) >= WHEEL_PX_PER_STEP) {
        step = Math.sign(this.acc);
        this.acc -= step * WHEEL_PX_PER_STEP;
      }
    }

    if (step === 0) return 0;
    if (timeStamp - this.lastStepAt < WHEEL_MIN_STEP_INTERVAL_MS) {
      this.acc = 0;
      return 0;
    }
    this.lastStepAt = timeStamp;
    return step;
  }
}

// ── Press-and-drag (touch, pen, mouse) ───────────────────────────────────────
//
// Dragging up tunes up. Fixed distance per step, no acceleration.
export const DRAG_PX_PER_STEP = 6;

export class DragStepAccumulator {
  private lastY = 0;
  private acc = 0;

  start(clientY: number): void {
    this.lastY = clientY;
    this.acc = 0;
  }

  /** Returns the signed number of steps the pointer has moved since the last call. */
  move(clientY: number): number {
    this.acc += this.lastY - clientY;
    this.lastY = clientY;
    const steps = Math.trunc(this.acc / DRAG_PX_PER_STEP);
    this.acc -= steps * DRAG_PX_PER_STEP;
    return steps;
  }
}

// ── CAT pacing ───────────────────────────────────────────────────────────────
//
// The display follows the knob instantly, but the radio is only sent the latest frequency, at most
// once per minIntervalMs and never while a previous set-frequency is still waiting for its ack,
// so a slow serial link can't build up a backlog. Once the radio has acked the final value,
// onSettled fires settleMs later; until then the caller treats the displayed frequency as
// not-yet-confirmed (dimmed, and incoming rig-status frequencies ignored).
export const KNOB_SEND_MIN_INTERVAL_MS = 100;
export const KNOB_SETTLE_MS = 500;

export interface KnobFrequencySenderOptions {
  /** Send one frequency; call done with the radio's read-back (or null if unknown/failed). */
  send: (freqHz: number, done: (confirmedHz: number | null) => void) => void;
  onSettled: (confirmedHz: number | null) => void;
  minIntervalMs?: number;
  settleMs?: number;
  now?: () => number;
}

export class KnobFrequencySender {
  private targetHz: number | null = null;
  private sentHz: number | null = null;
  private confirmedHz: number | null = null;
  private inFlight = false;
  private lastSentAt = -Infinity;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private readonly minIntervalMs: number;
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly opts: KnobFrequencySenderOptions;

  constructor(opts: KnobFrequencySenderOptions) {
    this.opts = opts;
    this.minIntervalMs = opts.minIntervalMs ?? KNOB_SEND_MIN_INTERVAL_MS;
    this.settleMs = opts.settleMs ?? KNOB_SETTLE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** The frequency the knob has asked for and the radio hasn't settled on yet, or null when idle. */
  get target(): number | null {
    return this.targetHz;
  }

  push(freqHz: number): void {
    this.targetHz = freqHz;
    this.clearSettle();
    this.schedule();
  }

  /** Abandon the knob session, e.g. because the frequency was set some other way. */
  cancel(): void {
    this.generation++;
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    this.clearSettle();
    this.targetHz = null;
    this.sentHz = null;
    this.confirmedHz = null;
    this.inFlight = false;
  }

  private schedule(): void {
    if (this.inFlight || this.sendTimer) return;
    const wait = Math.max(0, this.lastSentAt + this.minIntervalMs - this.now());
    this.sendTimer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.sendTimer = null;
    const target = this.targetHz;
    if (target === null) return;
    if (target === this.sentHz) {
      this.startSettle();
      return;
    }
    const gen = this.generation;
    this.inFlight = true;
    this.sentHz = target;
    this.lastSentAt = this.now();
    this.opts.send(target, (confirmedHz) => {
      if (gen !== this.generation) return;
      this.inFlight = false;
      this.confirmedHz = confirmedHz;
      if (this.targetHz !== this.sentHz) this.schedule();
      else this.startSettle();
    });
  }

  private startSettle(): void {
    this.clearSettle();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      const confirmed = this.confirmedHz;
      this.targetHz = null;
      this.sentHz = null;
      this.confirmedHz = null;
      this.opts.onSettled(confirmed);
    }, this.settleMs);
  }

  private clearSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }
}
