import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { flushPrefs, removePref, setPref, startPrefsSync, stopPrefsSync } from './userPrefsSync';

// Records emits only — userPrefsSync never listens on the socket.
class StubSocket {
  connected = true;
  emitted: Array<{ event: string; payload: any }> = [];
  emit(event: string, payload: any) {
    this.emitted.push({ event, payload });
    return this;
  }
}

function stub(): { socket: Socket; raw: StubSocket } {
  const raw = new StubSocket();
  return { socket: raw as unknown as Socket, raw };
}

beforeEach(() => {
  vi.useFakeTimers();
  stopPrefsSync({ discard: true });
  localStorage.clear();
});

afterEach(() => {
  stopPrefsSync({ discard: true });
  vi.useRealTimers();
});

describe('startPrefsSync hydration', () => {
  it('mirrors the server copy into localStorage, removing local-only keys for that user', () => {
    localStorage.setItem('W1AW:grid-layout-v1', 'local-layout');
    localStorage.setItem('W1AW:stale-key', 'x');
    localStorage.setItem('K2XYZ:grid-layout-v1', 'other-user');
    localStorage.setItem('auth-token', 'tok');
    const { socket, raw } = stub();

    startPrefsSync(socket, 'w1aw', { 'grid-layout-v1': 'server-layout', 'compact-vfo-collapsed': 'true' });

    expect(localStorage.getItem('W1AW:grid-layout-v1')).toBe('server-layout');
    expect(localStorage.getItem('W1AW:compact-vfo-collapsed')).toBe('true');
    expect(localStorage.getItem('W1AW:stale-key')).toBeNull();
    // Other users' and non-namespaced keys are untouched.
    expect(localStorage.getItem('K2XYZ:grid-layout-v1')).toBe('other-user');
    expect(localStorage.getItem('auth-token')).toBe('tok');
    expect(raw.emitted).toEqual([]);
  });

  it('never syncs or removes the device-local prefs-cleared-at marker', () => {
    localStorage.setItem('W1AW:prefs-cleared-at', '2026-01-01T00:00:00.000Z');
    localStorage.setItem('W1AW:grid-layout-v1', 'local');
    const { socket, raw } = stub();

    startPrefsSync(socket, 'W1AW', {});
    expect(localStorage.getItem('W1AW:prefs-cleared-at')).toBe('2026-01-01T00:00:00.000Z');
    expect(localStorage.getItem('W1AW:grid-layout-v1')).toBeNull();

    stopPrefsSync({ discard: true });
    startPrefsSync(socket, 'W1AW', null);
    expect(raw.emitted).toEqual([{ event: 'prefs:replace', payload: { prefs: {} } }]);
  });

  it('uploads existing local prefs once when the server has no record (null)', () => {
    localStorage.setItem('W1AW:grid-layout-v1', 'local-layout');
    localStorage.setItem('W1AW:compact-vfo-collapsed', 'false');
    localStorage.setItem('K2XYZ:grid-layout-v1', 'other-user');
    const { socket, raw } = stub();

    startPrefsSync(socket, 'W1AW', null);

    expect(raw.emitted).toEqual([{
      event: 'prefs:replace',
      payload: { prefs: { 'grid-layout-v1': 'local-layout', 'compact-vfo-collapsed': 'false' } },
    }]);
    expect(localStorage.getItem('W1AW:grid-layout-v1')).toBe('local-layout');
  });

  it('does nothing against a server that predates preference sync (undefined)', () => {
    localStorage.setItem('W1AW:grid-layout-v1', 'local-layout');
    const { socket, raw } = stub();

    startPrefsSync(socket, 'W1AW', undefined);
    setPref('W1AW:grid-layout-v1', 'changed');
    vi.runAllTimers();

    expect(localStorage.getItem('W1AW:grid-layout-v1')).toBe('changed');
    expect(raw.emitted).toEqual([]);
  });
});

describe('setPref / removePref sync', () => {
  it('batches changes to the bound user\'s keys into one prefs:update after a short delay', () => {
    const { socket, raw } = stub();
    startPrefsSync(socket, 'W1AW', {});

    setPref('W1AW:grid-layout-v1', 'a');
    setPref('W1AW:grid-layout-v1', 'b');
    setPref('W1AW:compact-vfo-collapsed', 'true');
    expect(raw.emitted).toEqual([]);

    vi.runAllTimers();

    expect(raw.emitted).toEqual([{
      event: 'prefs:update',
      payload: { changes: { 'grid-layout-v1': 'b', 'compact-vfo-collapsed': 'true' } },
    }]);
    expect(localStorage.getItem('W1AW:grid-layout-v1')).toBe('b');
  });

  it('sends removals as null', () => {
    localStorage.setItem('W1AW:mufmap-view-v1', '{}');
    const { socket, raw } = stub();
    startPrefsSync(socket, 'W1AW', { 'mufmap-view-v1': '{}' });

    removePref('W1AW:mufmap-view-v1');
    vi.runAllTimers();

    expect(localStorage.getItem('W1AW:mufmap-view-v1')).toBeNull();
    expect(raw.emitted).toEqual([{ event: 'prefs:update', payload: { changes: { 'mufmap-view-v1': null } } }]);
  });

  it('skips unchanged values, other users\' keys, and non-namespaced keys', () => {
    const { socket, raw } = stub();
    startPrefsSync(socket, 'W1AW', { 'compact-vfo-collapsed': 'true' });

    setPref('W1AW:compact-vfo-collapsed', 'true');
    setPref('K2XYZ:compact-vfo-collapsed', 'false');
    setPref('theme', 'light');
    vi.runAllTimers();

    expect(raw.emitted).toEqual([]);
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('does not sync while no user is bound', () => {
    const { raw } = stub();
    setPref('W1AW:grid-layout-v1', 'x');
    vi.runAllTimers();
    expect(raw.emitted).toEqual([]);
    expect(localStorage.getItem('W1AW:grid-layout-v1')).toBe('x');
  });

  it('holds changes made while disconnected and re-applies them over the next server snapshot', () => {
    const { socket, raw } = stub();
    startPrefsSync(socket, 'W1AW', { 'grid-layout-v1': 'old' });

    raw.connected = false;
    setPref('W1AW:grid-layout-v1', 'edited-offline');
    vi.runAllTimers();
    expect(raw.emitted).toEqual([]);

    // Reconnect: token refresh delivers the server's (older) snapshot.
    raw.connected = true;
    startPrefsSync(socket, 'W1AW', { 'grid-layout-v1': 'old', 'solar-collapsed': 'true' });

    expect(localStorage.getItem('W1AW:grid-layout-v1')).toBe('edited-offline');
    expect(localStorage.getItem('W1AW:solar-collapsed')).toBe('true');
    expect(raw.emitted).toEqual([{ event: 'prefs:update', payload: { changes: { 'grid-layout-v1': 'edited-offline' } } }]);
  });

  it('drops another user\'s pending changes when a different user logs in', () => {
    const { socket, raw } = stub();
    startPrefsSync(socket, 'W1AW', {});
    raw.connected = false;
    setPref('W1AW:grid-layout-v1', 'w1aw-edit');

    raw.connected = true;
    startPrefsSync(socket, 'K2XYZ', {});
    flushPrefs();

    expect(raw.emitted).toEqual([]);
  });
});

describe('stopPrefsSync', () => {
  it('flushes pending changes by default (logout)', () => {
    const { socket, raw } = stub();
    startPrefsSync(socket, 'W1AW', {});
    setPref('W1AW:grid-layout-v1', 'x');

    stopPrefsSync();

    expect(raw.emitted).toEqual([{ event: 'prefs:update', payload: { changes: { 'grid-layout-v1': 'x' } } }]);
    setPref('W1AW:grid-layout-v1', 'y');
    vi.runAllTimers();
    expect(raw.emitted).toHaveLength(1);
  });

  it('discards pending changes on request (admin preferences reset)', () => {
    const { socket, raw } = stub();
    startPrefsSync(socket, 'W1AW', {});
    setPref('W1AW:grid-layout-v1', 'x');

    stopPrefsSync({ discard: true });
    vi.runAllTimers();

    expect(raw.emitted).toEqual([]);
  });
});
