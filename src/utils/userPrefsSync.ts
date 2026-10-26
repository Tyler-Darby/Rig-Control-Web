import type { Socket } from "socket.io-client";

// Server-side mirror of a user's callsign-namespaced localStorage preferences
// (`${CALLSIGN}:<key>` — grid layout, panel collapse state, spectrum display
// settings, ...), so the same user sees the same layout on every device and
// every origin (IP vs hostname, port changes) they log in from.
//
// localStorage stays the synchronous read path every hook already uses: on
// login the server's copy is written into localStorage *before* currentUser
// is set (startPrefsSync), so callsign-keyed hooks re-read it as usual. Writes
// go through setPref/removePref, which update localStorage immediately and
// batch the change up to the server. Other open sessions pick changes up on
// their next login/reload — there is deliberately no live push.

const FLUSH_DELAY_MS = 400;

// Device-local bookkeeping that must never round-trip through the server.
const LOCAL_ONLY_KEYS = new Set(["prefs-cleared-at"]);

let boundSocket: Socket | null = null;
let boundPrefix: string | null = null;
const pending = new Map<string, string | null>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function prefixFor(callsign: string): string {
  return `${callsign.toUpperCase()}:`;
}

function isSyncableKey(key: string): boolean {
  return key.length > 0 && !LOCAL_ONLY_KEYS.has(key);
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPrefs();
  }, FLUSH_DELAY_MS);
}

function track(fullKey: string, value: string | null): void {
  if (!boundPrefix || !fullKey.startsWith(boundPrefix)) return;
  const key = fullKey.slice(boundPrefix.length);
  if (!isSyncableKey(key)) return;
  pending.set(key, value);
  scheduleFlush();
}

// Only flushes while connected: a change made while disconnected stays pending
// and is re-applied on top of the server snapshot by the next startPrefsSync
// (socket.io would otherwise buffer the emit and deliver it *after* the
// reconnect's token-refresh snapshot, leaving this tab hydrated to stale data).
export function flushPrefs(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!boundSocket?.connected || !boundPrefix || pending.size === 0) return;
  boundSocket.emit("prefs:update", { changes: Object.fromEntries(pending) });
  pending.clear();
}

export function setPref(key: string, value: string): void {
  try {
    if (localStorage.getItem(key) === value) return;
    localStorage.setItem(key, value);
  } catch {
    return;
  }
  track(key, value);
}

export function removePref(key: string): void {
  try {
    if (localStorage.getItem(key) === null) return;
    localStorage.removeItem(key);
  } catch {
    return;
  }
  track(key, null);
}

function localSyncableKeys(prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const fullKey = localStorage.key(i);
    if (fullKey?.startsWith(prefix) && isSyncableKey(fullKey.slice(prefix.length))) keys.push(fullKey);
  }
  return keys;
}

// Called on every successful auth (login or token refresh), before currentUser
// is set. `serverPrefs`:
//   - undefined: the server predates preference sync (e.g. an older remote
//     backend) — leave localStorage alone and don't sync.
//   - null: the server has no record for this user yet — upload this
//     browser's existing prefs once (prefs:replace; ignored server-side if
//     another device got there first).
//   - object: the server's copy is authoritative — mirror it into
//     localStorage, keeping any of this tab's not-yet-flushed changes on top.
export function startPrefsSync(
  socket: Socket,
  callsign: string,
  serverPrefs: Record<string, string> | null | undefined,
): void {
  const prefix = prefixFor(callsign);
  if (boundPrefix !== prefix) pending.clear();

  if (serverPrefs === undefined) {
    boundSocket = null;
    boundPrefix = null;
    pending.clear();
    return;
  }

  boundSocket = socket;
  boundPrefix = prefix;

  try {
    if (serverPrefs === null) {
      const prefs: Record<string, string> = {};
      for (const fullKey of localSyncableKeys(prefix)) {
        const value = localStorage.getItem(fullKey);
        if (value !== null) prefs[fullKey.slice(prefix.length)] = value;
      }
      socket.emit("prefs:replace", { prefs });
      pending.clear();
      return;
    }

    for (const fullKey of localSyncableKeys(prefix)) {
      const key = fullKey.slice(prefix.length);
      if (!Object.hasOwn(serverPrefs, key) && !pending.has(key)) localStorage.removeItem(fullKey);
    }
    for (const [key, value] of Object.entries(serverPrefs)) {
      if (!isSyncableKey(key) || pending.has(key)) continue;
      localStorage.setItem(prefix + key, value);
    }
    for (const [key, value] of pending) {
      if (value === null) localStorage.removeItem(prefix + key);
      else localStorage.setItem(prefix + key, value);
    }
  } catch {
    // storage unavailable — the session still works, just without persistence
  }
  if (pending.size > 0) flushPrefs();
}

// Logout: send anything still pending (the socket is still authenticated until
// auth:logout is processed, and emits are delivered in order), then unbind.
// Admin preferences reset: pass { discard: true } so in-flight writes of the
// about-to-be-cleared values can't re-upload them.
export function stopPrefsSync({ discard = false }: { discard?: boolean } = {}): void {
  if (discard) pending.clear();
  else flushPrefs();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pending.clear();
  boundSocket = null;
  boundPrefix = null;
}
