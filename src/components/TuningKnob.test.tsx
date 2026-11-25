import React from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TuningKnob from "./TuningKnob";
import { DRAG_PX_PER_STEP } from "../utils/tuningKnob";

// jsdom implements neither ResizeObserver nor pointer capture.
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});
afterAll(() => vi.unstubAllGlobals());

function renderKnob(disabled = false) {
  const onTune = vi.fn();
  render(
    <TuningKnob onTune={onTune} disabled={disabled} stepLabel="10Hz" accentClass="text-emerald-500" valueText="14.074000 MHz" />
  );
  return { onTune, knob: screen.getByTestId("tuning-knob") };
}

describe("TuningKnob", () => {
  it("tunes up on scroll-up and stops the page from scrolling", () => {
    const { onTune, knob } = renderKnob();
    const ev = new WheelEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true });
    knob.dispatchEvent(ev);
    expect(onTune).toHaveBeenCalledWith(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("ignores trackpad pinch (ctrl+wheel) but still blocks page zoom", () => {
    const { onTune, knob } = renderKnob();
    const ev = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true, bubbles: true });
    knob.dispatchEvent(ev);
    expect(onTune).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("press-and-drag up tunes up, down tunes down", () => {
    const { onTune, knob } = renderKnob();
    fireEvent.pointerDown(knob, { pointerId: 1, clientY: 100, button: 0, pointerType: "touch" });
    fireEvent.pointerMove(knob, { pointerId: 1, clientY: 100 - DRAG_PX_PER_STEP * 2 });
    fireEvent.pointerMove(knob, { pointerId: 1, clientY: 100 - DRAG_PX_PER_STEP });
    fireEvent.pointerUp(knob, { pointerId: 1 });
    expect(onTune.mock.calls).toEqual([[2], [-1]]);
  });

  it("ignores pointer moves without a press, and from a second finger", () => {
    const { onTune, knob } = renderKnob();
    fireEvent.pointerMove(knob, { pointerId: 1, clientY: 0 });
    fireEvent.pointerDown(knob, { pointerId: 1, clientY: 100, pointerType: "touch" });
    fireEvent.pointerDown(knob, { pointerId: 2, clientY: 100, pointerType: "touch" });
    fireEvent.pointerMove(knob, { pointerId: 2, clientY: 0 });
    expect(onTune).not.toHaveBeenCalled();
  });

  it("supports arrow and page keys", () => {
    const { onTune, knob } = renderKnob();
    fireEvent.keyDown(knob, { key: "ArrowUp" });
    fireEvent.keyDown(knob, { key: "ArrowLeft" });
    fireEvent.keyDown(knob, { key: "PageUp" });
    expect(onTune.mock.calls).toEqual([[1], [-1], [10]]);
  });

  it("does nothing while disabled, and lets the page scroll", () => {
    const { onTune, knob } = renderKnob(true);
    const ev = new WheelEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true });
    knob.dispatchEvent(ev);
    fireEvent.pointerDown(knob, { pointerId: 1, clientY: 100, pointerType: "touch" });
    fireEvent.pointerMove(knob, { pointerId: 1, clientY: 0 });
    fireEvent.keyDown(knob, { key: "ArrowUp" });
    expect(onTune).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});
