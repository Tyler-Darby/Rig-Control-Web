import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../utils";
import { DragStepAccumulator, WheelStepAccumulator } from "../utils/tuningKnob";

interface TuningKnobProps {
  /** Called with a signed step count; the caller applies its own step size. */
  onTune: (steps: number) => void;
  disabled: boolean;
  /** Shown in the knob's center, e.g. "10Hz". */
  stepLabel: string;
  /** Text color class for the knob's accent (indicator), matching the active VFO. */
  accentClass: string;
  /** Accessible current value, e.g. "14.074000 MHz". */
  valueText: string;
}

const DEG_PER_STEP = 12;
const PAGE_STEPS = 10;
const MIN_SIZE = 64;
const MAX_SIZE = 200;
const GRIP_RIDGES = 40;

// A VFO-style tuning knob that fills its container's height (and stays square). Input:
//  - mouse wheel / trackpad scroll over the knob (scroll up = frequency up), tamed by
//    WheelStepAccumulator for over-eager Apple trackpads;
//  - press and drag vertically with touch, pen or mouse (drag up = frequency up);
//  - arrow keys / Page Up / Page Down when focused.
export default function TuningKnob({ onTune, disabled, stepLabel, accentClass, valueText }: TuningKnobProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(0);
  const [angle, setAngle] = useState(0);
  const [dragging, setDragging] = useState(false);

  const onTuneRef = useRef(onTune);
  onTuneRef.current = onTune;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const wheelRef = useRef(new WheelStepAccumulator());
  const dragRef = useRef(new DragStepAccumulator());
  const activePointerRef = useRef<number | null>(null);

  const tune = (steps: number) => {
    if (steps === 0 || disabledRef.current) return;
    setAngle(a => a + steps * DEG_PER_STEP);
    onTuneRef.current(steps);
  };
  const tuneRef = useRef(tune);
  tuneRef.current = tune;

  // Square, as tall as the stretched container. The container's height comes from the rest of
  // the VFO pane, so only the width is driven from here.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const h = el.clientHeight;
      setSize(Math.round(Math.max(MIN_SIZE, Math.min(MAX_SIZE, h))));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // React registers wheel listeners as passive, so preventDefault() there can't stop the page
  // from scrolling; attach a non-passive native listener instead.
  useEffect(() => {
    const el = knobRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (disabledRef.current) return;
      e.preventDefault();
      if (e.ctrlKey) return; // trackpad pinch-zoom gesture, not a scroll
      tuneRef.current(wheelRef.current.push(e.deltaY, e.deltaMode, e.timeStamp));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerRef.current !== e.pointerId) return;
    activePointerRef.current = null;
    setDragging(false);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || activePointerRef.current !== null) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Pointer capture keeps the drag going when the finger/pointer leaves the knob. Focus is left
    // to the browser (a click still focuses it for arrow keys, without a :focus-visible ring).
    e.currentTarget.setPointerCapture(e.pointerId);
    activePointerRef.current = e.pointerId;
    dragRef.current.start(e.clientY);
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerRef.current !== e.pointerId) return;
    tune(dragRef.current.move(e.clientY));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const steps =
      e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 :
      e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 :
      e.key === "PageUp" ? PAGE_STEPS :
      e.key === "PageDown" ? -PAGE_STEPS : 0;
    if (steps === 0) return;
    e.preventDefault();
    tune(steps);
  };

  const ridges = Array.from({ length: GRIP_RIDGES }, (_, i) => (i * 360) / GRIP_RIDGES);

  return (
    // The knob is absolutely positioned so it never contributes to the row height it measures.
    <div ref={containerRef} className="relative self-stretch flex-shrink-0" style={{ width: size }}>
      <div
        ref={knobRef}
        role="slider"
        aria-label="Tuning knob"
        aria-valuetext={valueText}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        title="Tuning knob: scroll, or press and drag up/down"
        data-testid="tuning-knob"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          "absolute inset-0 m-auto rounded-full select-none outline-none focus-visible:ring-2 focus-visible:ring-current",
          accentClass,
          disabled ? "opacity-50 cursor-not-allowed" : dragging ? "cursor-grabbing" : "cursor-grab"
        )}
        style={{ width: size, height: size, touchAction: "none", WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
      >
        <svg viewBox="0 0 100 100" width={size} height={size} className="block">
          <circle cx="50" cy="50" r="49" fill="var(--color-app)" stroke="var(--color-line)" strokeWidth="1" />
          <g transform={`rotate(${angle} 50 50)`}>
            <circle cx="50" cy="50" r="44" fill="var(--color-panel-2)" stroke="var(--color-line-strong)" strokeWidth="1.5" />
            {ridges.map(deg => (
              <line
                key={deg}
                x1="50" y1="7.5" x2="50" y2="12"
                stroke="var(--color-line-strong)"
                strokeWidth="1.2"
                strokeLinecap="round"
                transform={`rotate(${deg} 50 50)`}
              />
            ))}
            <circle cx="50" cy="50" r="36" fill="var(--color-panel)" stroke="var(--color-line)" strokeWidth="1" />
            {/* finger dimple + indicator, like the spinner dimple on a radio's main dial */}
            <circle cx="50" cy="26" r="7" fill="var(--color-panel-2)" stroke="var(--color-line-strong)" strokeWidth="1" />
            <circle cx="50" cy="17" r="2" fill="currentColor" />
          </g>
          <text
            x="50" y="54"
            textAnchor="middle"
            fontSize="10"
            fontWeight="700"
            fill="var(--color-muted)"
            className="font-mono pointer-events-none"
          >{stepLabel}</text>
        </svg>
      </div>
    </div>
  );
}
