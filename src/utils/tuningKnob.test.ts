import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAG_PX_PER_STEP,
  DragStepAccumulator,
  KnobFrequencySender,
  WHEEL_GESTURE_GAP_MS,
  WHEEL_MIN_STEP_INTERVAL_MS,
  WHEEL_PX_PER_STEP,
  WheelStepAccumulator,
} from './tuningKnob';

const PIXEL = 0;
const LINE = 1;

describe('WheelStepAccumulator', () => {
  it('tunes up for scroll-up (negative deltaY) and down for scroll-down', () => {
    expect(new WheelStepAccumulator().push(-100, PIXEL, 1000)).toBe(1);
    expect(new WheelStepAccumulator().push(100, PIXEL, 1000)).toBe(-1);
  });

  it('moves exactly one step per isolated event, however small or large (mouse notches)', () => {
    const acc = new WheelStepAccumulator();
    const gap = WHEEL_GESTURE_GAP_MS + 1;
    // A slow macOS mouse notch can be ~4 px; a Windows/Linux Chrome notch ~100 px.
    expect(acc.push(-4, PIXEL, 1000)).toBe(1);
    expect(acc.push(-4, PIXEL, 1000 + gap)).toBe(1);
    expect(acc.push(-500, PIXEL, 1000 + 2 * gap)).toBe(1);
  });

  it('accumulates small continuous trackpad deltas into one step per WHEEL_PX_PER_STEP', () => {
    const acc = new WheelStepAccumulator();
    let t = 1000;
    let steps = acc.push(-2, PIXEL, t); // gesture start: immediate step
    expect(steps).toBe(1);
    steps = 0;
    for (let i = 0; i < WHEEL_PX_PER_STEP * 3 / 2; i++) {
      t += 8;
      steps += acc.push(-2, PIXEL, t);
    }
    expect(steps).toBe(3);
  });

  it('never moves more than one step for a single huge delta', () => {
    const acc = new WheelStepAccumulator();
    acc.push(-10, PIXEL, 1000);
    expect(acc.push(-5000, PIXEL, 1000 + WHEEL_MIN_STEP_INTERVAL_MS)).toBe(1);
  });

  it('rate-limits fast trackpad flicks and drops the excess instead of banking it', () => {
    const acc = new WheelStepAccumulator();
    let t = 1000;
    let steps = acc.push(-200, PIXEL, t);
    // 120 Hz of max-size deltas for one second
    for (let i = 0; i < 120; i++) {
      t += 1000 / 120;
      steps += acc.push(-200, PIXEL, t);
    }
    expect(steps).toBeLessThanOrEqual(Math.ceil(1000 / WHEEL_MIN_STEP_INTERVAL_MS) + 1);
    expect(steps).toBeGreaterThan(10);
  });

  it('requires a full step of travel after a direction reversal (ignores momentum-tail blips)', () => {
    const acc = new WheelStepAccumulator();
    let t = 1000;
    acc.push(-2, PIXEL, t);
    for (let i = 0; i < 10; i++) acc.push(-2, PIXEL, (t += 8));
    expect(acc.push(3, PIXEL, (t += 8))).toBe(0);
    expect(acc.push(-2, PIXEL, (t += 8))).toBe(0);
  });

  it('converts line-mode deltas (Firefox) to pixels', () => {
    const acc = new WheelStepAccumulator();
    acc.push(-1, LINE, 1000);
    expect(acc.push(-1, LINE, 1000 + WHEEL_MIN_STEP_INTERVAL_MS)).toBe(1);
  });
});

describe('DragStepAccumulator', () => {
  it('tunes up when dragging up, down when dragging down, one step per DRAG_PX_PER_STEP', () => {
    const drag = new DragStepAccumulator();
    drag.start(200);
    expect(drag.move(200 - DRAG_PX_PER_STEP * 3)).toBe(3);
    expect(drag.move(200 + DRAG_PX_PER_STEP)).toBe(-4);
  });

  it('carries sub-step movement over to the next move', () => {
    const drag = new DragStepAccumulator();
    drag.start(100);
    expect(drag.move(100 - DRAG_PX_PER_STEP / 2)).toBe(0);
    expect(drag.move(100 - DRAG_PX_PER_STEP)).toBe(1);
  });
});

describe('KnobFrequencySender', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const sent: number[] = [];
    const acks: Array<(hz: number | null) => void> = [];
    const settled: Array<number | null> = [];
    const sender = new KnobFrequencySender({
      send: (hz, done) => { sent.push(hz); acks.push(done); },
      onSettled: (hz) => settled.push(hz),
      minIntervalMs: 100,
      settleMs: 500,
      now: () => Date.now(),
    });
    return { sender, sent, acks, settled };
  }

  it('sends the first value right away', () => {
    const { sender, sent } = setup();
    sender.push(14074010);
    vi.advanceTimersByTime(0);
    expect(sent).toEqual([14074010]);
    expect(sender.target).toBe(14074010);
  });

  it('keeps one send in flight and then sends only the newest value', () => {
    const { sender, sent, acks } = setup();
    sender.push(1);
    vi.advanceTimersByTime(0);
    sender.push(2);
    sender.push(3);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([1]);
    acks[0](1);
    vi.advanceTimersByTime(0);
    expect(sent).toEqual([1, 3]);
  });

  it('spaces sends at least minIntervalMs apart even when acks are instant', () => {
    const { sender, sent, acks } = setup();
    sender.push(1);
    vi.advanceTimersByTime(0);
    acks[0](1);
    sender.push(2);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([1, 2]);
  });

  it('settles settleMs after the final ack, reporting the read-back', () => {
    const { sender, acks, settled } = setup();
    sender.push(14074010);
    vi.advanceTimersByTime(0);
    acks[0](14074000);
    vi.advanceTimersByTime(499);
    expect(settled).toEqual([]);
    expect(sender.target).toBe(14074010);
    vi.advanceTimersByTime(1);
    expect(settled).toEqual([14074000]);
    expect(sender.target).toBeNull();
  });

  it('a new push during the settle window postpones settling', () => {
    const { sender, acks, settled, sent } = setup();
    sender.push(1);
    vi.advanceTimersByTime(0);
    acks[0](1);
    vi.advanceTimersByTime(400);
    sender.push(2);
    vi.advanceTimersByTime(400);
    expect(sent).toEqual([1, 2]);
    expect(settled).toEqual([]);
    acks[1](2);
    vi.advanceTimersByTime(500);
    expect(settled).toEqual([2]);
  });

  it('cancel() drops pending work and ignores a late ack', () => {
    const { sender, acks, settled, sent } = setup();
    sender.push(1);
    vi.advanceTimersByTime(0);
    sender.push(2);
    sender.cancel();
    acks[0](1);
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([1]);
    expect(settled).toEqual([]);
    expect(sender.target).toBeNull();
  });
});
