// @vitest-environment node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PREF_KEYS,
  MAX_PREF_VALUE_BYTES,
  applyPrefChanges,
  deleteAllUserPrefs,
  deleteUserPrefs,
  getUserPrefs,
  isValidPrefKey,
  registerUserPrefsHandlers,
  resetUserPrefs,
} from './userPrefs.ts';

// Captures the handlers registerUserPrefsHandlers attaches so tests can invoke
// them directly, without a real Socket.io server.
function fakeSocket(id = 'socket-1') {
  const handlers = new Map<string, (payload: any) => void>();
  return {
    id,
    emit: vi.fn(),
    on: (event: string, handler: (payload: any) => void) => { handlers.set(event, handler); },
    trigger: (event: string, payload: any) => handlers.get(event)!(payload),
  };
}

let dataDir: string;

function fakeCtx(authenticatedSockets: Map<string, any> = new Map()) {
  return { dataDir, authenticatedSockets } as any;
}

function authedSocket(callsign = 'W1AW') {
  const socket = fakeSocket();
  const ctx = fakeCtx(new Map([[socket.id, { callsign, role: 'regular', connectedAt: 0, ip: '127.0.0.1' }]]));
  registerUserPrefsHandlers(socket as any, ctx);
  return { socket, ctx };
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-prefs-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('isValidPrefKey', () => {
  it('accepts the key shapes the frontend actually uses', () => {
    for (const key of ['grid-layout-v1', 'mufmap-view-v1', 'spectrum-hamlib-autoFloor-ft4222', 'compact-vfo-collapsed']) {
      expect(isValidPrefKey(key)).toBe(true);
    }
  });

  it('rejects empty, oversized, prefixed, non-string and prototype-polluting keys', () => {
    for (const key of ['', 'a'.repeat(129), 'W1AW:grid-layout-v1', 'has space', 42, null, '__proto__', 'constructor']) {
      expect(isValidPrefKey(key)).toBe(false);
    }
  });
});

describe('applyPrefChanges', () => {
  it('sets, overwrites and deletes (null) keys without mutating the base', () => {
    const base = { a: '1', b: '2' };
    const result = applyPrefChanges(base, { a: 'x', b: null, c: '3' });
    expect(result).toEqual({ prefs: { a: 'x', c: '3' } });
    expect(base).toEqual({ a: '1', b: '2' });
  });

  it('rejects non-object payloads, bad keys and non-string values', () => {
    expect(applyPrefChanges({}, undefined)).toHaveProperty('error');
    expect(applyPrefChanges({}, ['a'])).toHaveProperty('error');
    expect(applyPrefChanges({}, { 'bad key': 'x' })).toHaveProperty('error');
    expect(applyPrefChanges({}, { a: 5 })).toHaveProperty('error');
  });

  it('enforces the per-value, key-count and total-size limits', () => {
    expect(applyPrefChanges({}, { a: 'x'.repeat(MAX_PREF_VALUE_BYTES + 1) })).toHaveProperty('error');

    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_PREF_KEYS; i++) many[`k${i}`] = '1';
    expect(applyPrefChanges({}, many)).toHaveProperty('error');

    const big: Record<string, string> = {};
    for (let i = 0; i < 5; i++) big[`k${i}`] = 'x'.repeat(MAX_PREF_VALUE_BYTES);
    expect(applyPrefChanges({}, big)).toHaveProperty('error');
  });
});

describe('prefs storage', () => {
  it('returns null for a user with no record, and the stored map once written', () => {
    const { socket, ctx } = authedSocket();
    expect(getUserPrefs(ctx, 'W1AW')).toBeNull();

    socket.trigger('prefs:update', { changes: { 'grid-layout-v1': '{"x":1}' } });

    expect(getUserPrefs(ctx, 'W1AW')).toEqual({ 'grid-layout-v1': '{"x":1}' });
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('writes the file with owner-only permissions', () => {
    const { socket } = authedSocket();
    socket.trigger('prefs:update', { changes: { a: '1' } });
    const mode = fs.statSync(path.join(dataDir, 'user-prefs.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('keeps users isolated from each other', () => {
    const a = authedSocket('W1AW');
    const b = authedSocket('K2XYZ');
    a.socket.trigger('prefs:update', { changes: { theme: 'a' } });
    b.socket.trigger('prefs:update', { changes: { theme: 'b' } });
    expect(getUserPrefs(a.ctx, 'W1AW')).toEqual({ theme: 'a' });
    expect(getUserPrefs(a.ctx, 'K2XYZ')).toEqual({ theme: 'b' });
  });

  it('resetUserPrefs leaves an empty record (not "no record"), deleteUserPrefs removes it', () => {
    const { socket, ctx } = authedSocket();
    socket.trigger('prefs:update', { changes: { a: '1' } });

    resetUserPrefs(ctx, 'W1AW');
    expect(getUserPrefs(ctx, 'W1AW')).toEqual({});

    deleteUserPrefs(ctx, 'W1AW');
    expect(getUserPrefs(ctx, 'W1AW')).toBeNull();
  });

  it('treats a corrupt file as empty rather than throwing', () => {
    fs.writeFileSync(path.join(dataDir, 'user-prefs.json'), '{not json');
    expect(getUserPrefs(fakeCtx(), 'W1AW')).toBeNull();
  });
});

describe('prefs socket handlers', () => {
  it('rejects writes from an unauthenticated socket', () => {
    const socket = fakeSocket();
    const ctx = fakeCtx();
    registerUserPrefsHandlers(socket as any, ctx);

    socket.trigger('prefs:update', { changes: { a: '1' } });
    socket.trigger('prefs:replace', { prefs: { a: '1' } });

    expect(socket.emit).toHaveBeenCalledWith('auth:required');
    expect(getUserPrefs(ctx, 'W1AW')).toBeNull();
  });

  it('reports invalid updates via prefs:error and leaves stored prefs unchanged', () => {
    const { socket, ctx } = authedSocket();
    socket.trigger('prefs:update', { changes: { a: '1' } });

    socket.trigger('prefs:update', { changes: { a: '2', 'bad key': 'x' } });
    socket.trigger('prefs:update', undefined);

    expect(socket.emit).toHaveBeenCalledWith('prefs:error', expect.objectContaining({ error: expect.any(String) }));
    expect(getUserPrefs(ctx, 'W1AW')).toEqual({ a: '1' });
  });

  it('prefs:replace only seeds a user with no record — the first device wins', () => {
    const { socket, ctx } = authedSocket();

    socket.trigger('prefs:replace', { prefs: { 'grid-layout-v1': 'first' } });
    socket.trigger('prefs:replace', { prefs: { 'grid-layout-v1': 'second' } });

    expect(getUserPrefs(ctx, 'W1AW')).toEqual({ 'grid-layout-v1': 'first' });
  });

  it('prefs:replace does not overwrite an admin-reset (empty) record', () => {
    const { socket, ctx } = authedSocket();
    resetUserPrefs(ctx, 'W1AW');

    socket.trigger('prefs:replace', { prefs: { 'grid-layout-v1': 'stale' } });

    expect(getUserPrefs(ctx, 'W1AW')).toEqual({});
  });
});

describe('deleteAllUserPrefs', () => {
  it('removes every user\'s stored prefs and tolerates a missing file', () => {
    const a = authedSocket('W1AW');
    a.socket.trigger('prefs:update', { changes: { a: '1' } });

    deleteAllUserPrefs(a.ctx);
    expect(getUserPrefs(a.ctx, 'W1AW')).toBeNull();
    expect(() => deleteAllUserPrefs(a.ctx)).not.toThrow();
  });
});
