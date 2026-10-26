import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLayoutConfig, DEFAULT_COMPACT_LAYOUT, DEFAULT_PHONE_LAYOUT } from './useLayoutConfig';
import type { GridItem } from '../types/layout';

beforeEach(() => {
  localStorage.clear();
});

function setCompactItems(
  result: { current: ReturnType<typeof useLayoutConfig> },
  items: GridItem[],
  cols = 3,
) {
  act(() => {
    result.current.setCompactLayout({ cols, rows: 10, items });
  });
}

describe('useLayoutConfig addPanel — compact column placement', () => {
  it('places a new panel in the column with the fewest existing items when no targetX is given', () => {
    const { result } = renderHook(() => useLayoutConfig());
    setCompactItems(result, [
      { i: 'a', x: 0, y: 0, w: 1, h: 1, panelType: 'controls' },
      { i: 'b', x: 0, y: 1, w: 1, h: 1, panelType: 'rflevels' },
    ]);

    act(() => {
      result.current.addPanel('compact', 'solar');
    });

    const added = result.current.compactLayout.items.find(i => i.panelType === 'solar');
    // No targetX supplied -> falls back to legacy behavior (column 0).
    expect(added?.x).toBe(0);
  });

  it('places a new panel in the explicitly targeted column, stacked below existing items there', () => {
    const { result } = renderHook(() => useLayoutConfig());
    setCompactItems(result, [
      { i: 'a', x: 0, y: 0, w: 1, h: 1, panelType: 'controls' },
      { i: 'b', x: 1, y: 0, w: 1, h: 2, panelType: 'spectrum_hamlib' },
    ]);

    act(() => {
      result.current.addPanel('compact', 'solar', { targetX: 1 });
    });

    const added = result.current.compactLayout.items.find(i => i.panelType === 'solar');
    expect(added?.x).toBe(1);
    // Stacked below item 'b' (y:0, h:2), not appended after the global max.
    expect(added?.y).toBe(2);
  });

  it('ignores targetX for full-width panels and keeps them at x:0', () => {
    const { result } = renderHook(() => useLayoutConfig());
    setCompactItems(result, [
      { i: 'a', x: 0, y: 0, w: 1, h: 1, panelType: 'controls' },
      { i: 'b', x: 1, y: 0, w: 1, h: 1, panelType: 'smeter' },
    ]);

    act(() => {
      result.current.addPanel('compact', 'vfo', { fullWidth: true, targetX: 1 });
    });

    const added = result.current.compactLayout.items.find(i => i.panelType === 'vfo');
    expect(added?.x).toBe(0);
    expect(added?.w).toBe(9999);
  });

  it('does not apply targetX-based placement to the phone view', () => {
    const { result } = renderHook(() => useLayoutConfig());
    act(() => {
      result.current.setPhoneLayout({
        cols: 1,
        rows: 10,
        items: [{ i: 'a', x: 0, y: 0, w: 1, h: 1, panelType: 'controls' }],
      });
    });

    act(() => {
      result.current.addPanel('phone', 'solar', { targetX: 0 });
    });

    const added = result.current.phoneLayout.items.find(i => i.panelType === 'solar');
    // Phone view always appends at the global max y, regardless of targetX.
    expect(added?.x).toBe(0);
    expect(added?.y).toBe(1);
  });
});

// The hook mounts before auth resolves (callsign ""), then re-renders with the real
// callsign once login completes. setCompactLayout/setPhoneLayout/addPanel/setGridSize/
// updateItemPositions must pick up the new callsign-derived storage key at that point,
// not keep writing to the stale unprefixed key captured on first render.
describe('useLayoutConfig storage key tracks callsign after it resolves post-mount', () => {
  it('addPanel writes to the callsign-prefixed key, not the stale unprefixed one', () => {
    const { result, rerender } = renderHook(
      ({ callsign }: { callsign: string }) => useLayoutConfig(callsign),
      { initialProps: { callsign: '' } },
    );

    rerender({ callsign: 'W1AW' });

    act(() => {
      result.current.addPanel('compact', 'solar');
    });

    expect(localStorage.getItem('grid-layout-v1')).toBeNull();
    const stored = JSON.parse(localStorage.getItem('W1AW:grid-layout-v1')!);
    expect(stored.compact.items.some((i: GridItem) => i.panelType === 'solar')).toBe(true);
  });

  it('setGridSize writes to the callsign-prefixed key, not the stale unprefixed one', () => {
    const { result, rerender } = renderHook(
      ({ callsign }: { callsign: string }) => useLayoutConfig(callsign),
      { initialProps: { callsign: '' } },
    );

    rerender({ callsign: 'W1AW' });

    act(() => {
      result.current.setGridSize('compact', 4, 8);
    });

    expect(localStorage.getItem('grid-layout-v1')).toBeNull();
    const stored = JSON.parse(localStorage.getItem('W1AW:grid-layout-v1')!);
    expect(stored.compact.cols).toBe(4);
    expect(stored.compact.rows).toBe(8);
  });

  it('re-reads the callsign-prefixed saved layout once callsign resolves, instead of keeping the pre-auth default', () => {
    const savedItems = DEFAULT_COMPACT_LAYOUT.items.filter(i => i.panelType !== 'solar');
    localStorage.setItem('W1AW:grid-layout-v1', JSON.stringify({
      compact: { cols: 3, rows: 6, items: savedItems },
      phone: DEFAULT_PHONE_LAYOUT,
    }));

    const { result, rerender } = renderHook(
      ({ callsign }: { callsign: string }) => useLayoutConfig(callsign),
      { initialProps: { callsign: '' } },
    );

    // Pre-auth mount: no unprefixed key saved, so it falls back to the default layout.
    expect(result.current.compactLayout.items.some(i => i.panelType === 'solar')).toBe(true);

    rerender({ callsign: 'W1AW' });

    // Post-auth: the returning user's saved layout (missing 'solar') is restored,
    // not left at the pre-auth default.
    expect(result.current.compactLayout.items.some(i => i.panelType === 'solar')).toBe(false);
    expect(result.current.compactLayout.items.length).toBe(savedItems.length);
  });
});

// Regression: setGridSize used to also drop every item with y >= rows. The compact
// rows control is hidden and fixed at the default 6, while addPanel stacks new
// panels below everything else in their column — so a panel added to a column
// landed at y >= 6 and was silently deleted by the next cols change.
describe('useLayoutConfig setGridSize', () => {
  it('keeps panels below the nominal row count when the column count changes', () => {
    const { result } = renderHook(() => useLayoutConfig('W1AW'));

    act(() => {
      result.current.addPanel('compact', 'cwdecode', { targetX: 1 });
    });
    const added = result.current.compactLayout.items.find(i => i.panelType === 'cwdecode')!;
    expect(added.y).toBeGreaterThanOrEqual(result.current.compactLayout.rows);

    act(() => {
      result.current.setGridSize('compact', 4, result.current.compactLayout.rows);
    });

    const kept = result.current.compactLayout.items.find(i => i.panelType === 'cwdecode');
    expect(kept).toBeDefined();
    expect(kept!.h).toBe(added.h);
    const stored = JSON.parse(localStorage.getItem('W1AW:grid-layout-v1')!);
    expect(stored.compact.items.some((i: GridItem) => i.panelType === 'cwdecode')).toBe(true);
  });

  it('still drops panels in columns removed by shrinking the column count', () => {
    const { result } = renderHook(() => useLayoutConfig('W1AW'));

    act(() => {
      result.current.setGridSize('compact', 2, result.current.compactLayout.rows);
    });

    const items = result.current.compactLayout.items;
    expect(items.some(i => i.x >= 2)).toBe(false);
    // Full-width vfo (x 0) survives.
    expect(items.some(i => i.panelType === 'vfo')).toBe(true);
  });
});
