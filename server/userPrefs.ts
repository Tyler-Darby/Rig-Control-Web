import fs from "fs";
import path from "path";
import type { Socket } from "socket.io";
import type { ServerContext } from "./context.ts";

// Per-user UI preferences (panel grid layout, collapse state, spectrum display
// settings, ...) mirrored from each browser's callsign-namespaced localStorage
// keys, so a user gets the same layout on every device/origin they log in from.
// Values are opaque strings — the server never interprets them, it only stores
// the raw localStorage value under the un-prefixed key name.

interface UserPrefsRecord {
  prefs: Record<string, string>;
  updatedAt: string;
}

interface UserPrefsFile {
  users: Record<string, UserPrefsRecord>;
}

// Bounds keep one (authenticated) client from growing the file without limit.
// Real usage today is ~60 keys and well under 32 KiB in total.
export const MAX_PREF_KEYS = 256;
export const MAX_PREF_KEY_LENGTH = 128;
export const MAX_PREF_VALUE_BYTES = 64 * 1024;
export const MAX_PREFS_TOTAL_BYTES = 256 * 1024;

const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function prefsFilePath(ctx: ServerContext) {
  return path.join(ctx.dataDir, "user-prefs.json");
}

function loadFile(ctx: ServerContext): UserPrefsFile {
  try {
    const raw = fs.readFileSync(prefsFilePath(ctx), "utf-8");
    const parsed = JSON.parse(raw) as UserPrefsFile;
    if (parsed && typeof parsed.users === "object" && parsed.users !== null) return parsed;
  } catch { /* file may not exist yet */ }
  return { users: {} };
}

function saveFile(ctx: ServerContext, file: UserPrefsFile): void {
  const filePath = prefsFilePath(ctx);
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
}

export function isValidPrefKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= MAX_PREF_KEY_LENGTH &&
    KEY_PATTERN.test(key) &&
    !FORBIDDEN_KEYS.has(key)
  );
}

function totalBytes(prefs: Record<string, string>): number {
  let n = 0;
  for (const [k, v] of Object.entries(prefs)) n += Buffer.byteLength(k) + Buffer.byteLength(v);
  return n;
}

// Applies `changes` (null value = delete) on top of `base`, returning the new
// map or an error string if any key/value is invalid or a limit is exceeded.
// Pure — exported for tests.
export function applyPrefChanges(
  base: Record<string, string>,
  changes: unknown,
): { prefs: Record<string, string> } | { error: string } {
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) {
    return { error: "Invalid preferences payload" };
  }
  const next: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(changes as Record<string, unknown>)) {
    if (!isValidPrefKey(key)) return { error: `Invalid preference key: ${String(key).slice(0, 40)}` };
    if (value === null) {
      delete next[key];
      continue;
    }
    if (typeof value !== "string") return { error: `Invalid value for preference ${key}` };
    if (Buffer.byteLength(value) > MAX_PREF_VALUE_BYTES) return { error: `Preference ${key} is too large` };
    next[key] = value;
  }
  if (Object.keys(next).length > MAX_PREF_KEYS) return { error: "Too many preferences" };
  if (totalBytes(next) > MAX_PREFS_TOTAL_BYTES) return { error: "Preferences too large" };
  return { prefs: next };
}

// null = no record stored yet (the client then uploads its local prefs once).
export function getUserPrefs(ctx: ServerContext, callsign: string): Record<string, string> | null {
  const file = loadFile(ctx);
  if (!Object.hasOwn(file.users, callsign)) return null;
  return file.users[callsign].prefs ?? {};
}

function setUserPrefs(ctx: ServerContext, callsign: string, prefs: Record<string, string>): void {
  const file = loadFile(ctx);
  file.users[callsign] = { prefs, updatedAt: new Date().toISOString() };
  saveFile(ctx, file);
}

// Admin "Clear Preferences": store an *empty* record rather than deleting it,
// so the user's next login hydrates every device to defaults instead of
// treating the server as empty and re-uploading the stale local prefs.
export function resetUserPrefs(ctx: ServerContext, callsign: string): void {
  setUserPrefs(ctx, callsign, {});
}

export function deleteUserPrefs(ctx: ServerContext, callsign: string): void {
  const file = loadFile(ctx);
  if (!Object.hasOwn(file.users, callsign)) return;
  delete file.users[callsign];
  saveFile(ctx, file);
}

// Factory reset: every account is recreated from scratch, so no stored prefs
// may carry over to the re-seeded ADMIN (or a later user reusing a callsign).
export function deleteAllUserPrefs(ctx: ServerContext): void {
  try { fs.unlinkSync(prefsFilePath(ctx)); } catch { /* may not exist */ }
}

// Registered for every socket alongside the auth handlers (not gated on the
// functional-handler registration) so a must-change-password session can still
// persist; each event checks authentication itself.
export function registerUserPrefsHandlers(socket: Socket, ctx: ServerContext): void {
  const authedCallsign = (): string | null =>
    ctx.authenticatedSockets.get(socket.id)?.callsign ?? null;

  socket.on("prefs:update", (payload: { changes?: unknown } | undefined) => {
    const callsign = authedCallsign();
    if (!callsign) {
      socket.emit("auth:required");
      return;
    }
    try {
      const result = applyPrefChanges(getUserPrefs(ctx, callsign) ?? {}, payload?.changes);
      if ("error" in result) {
        socket.emit("prefs:error", { error: result.error });
        return;
      }
      setUserPrefs(ctx, callsign, result.prefs);
    } catch (err) {
      console.error("[PREFS] Failed to save preferences:", err);
      socket.emit("prefs:error", { error: "Internal server error" });
    }
  });

  // One-time upload of a browser's existing local prefs when the server has no
  // record for this user yet. Ignored if a record already exists, so two
  // devices logging in for the first time can't clobber each other — the
  // first upload wins and later ones get hydrated from it on next login.
  socket.on("prefs:replace", (payload: { prefs?: unknown } | undefined) => {
    const callsign = authedCallsign();
    if (!callsign) {
      socket.emit("auth:required");
      return;
    }
    try {
      if (getUserPrefs(ctx, callsign) !== null) return;
      const result = applyPrefChanges({}, payload?.prefs);
      if ("error" in result) {
        socket.emit("prefs:error", { error: result.error });
        return;
      }
      setUserPrefs(ctx, callsign, result.prefs);
    } catch (err) {
      console.error("[PREFS] Failed to save preferences:", err);
      socket.emit("prefs:error", { error: "Internal server error" });
    }
  });
}
