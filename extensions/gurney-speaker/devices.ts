// Per-device state persistence. The speaker_devices migration (0001) gives
// us a row per puck so we can:
//   - Remember the volume / mute that *the device* last reported, and replay
//     it in the welcome frame instead of always starting from the schema
//     default. Without this, a power-cycled puck snaps back to 60 % volume on
//     reconnect even if the user had it down to 20 %.
//   - Surface a "known devices" view for `gurney status` (future) so an
//     operator can see which pucks have been online recently.
//
// All reads and writes go through prepared statements so the dispatcher's
// hot path (one connect, dozens of state syncs per session) doesn't repay
// query compilation costs.

import type { DB } from '../../src/storage/db.js';

export interface DeviceRow {
  deviceId: string;
  label: string | null;
  lastSeen: number;
  lastVolume: number;
  muted: boolean;
  createdAt: number;
}

export interface DeviceStore {
  // Fetch the row for a device id, or null if we've never seen it.
  get(deviceId: string): DeviceRow | null;
  // Idempotent: creates the row if missing, otherwise bumps last_seen.
  // Returns the row as it now stands so the caller can drive the welcome
  // payload from a single read.
  touch(deviceId: string, now?: number): DeviceRow;
  // Update the persisted volume + mute. Called whenever a device pushes a
  // STATE_SYNC_C frame so we keep the database in lockstep with what's
  // actually playing.
  saveVolumeMuted(deviceId: string, volume: number, muted: boolean, now?: number): void;
  // Update only last_seen — used on disconnect so "last online" is accurate
  // even when no state sync happened in the session.
  markSeen(deviceId: string, now?: number): void;
}

export function createDeviceStore(db: DB): DeviceStore {
  const insertStmt = db.prepare(
    `INSERT INTO speaker_devices (device_id, last_seen, last_volume, muted)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET last_seen = excluded.last_seen`,
  );
  const selectStmt = db.prepare(
    `SELECT device_id AS deviceId, label, last_seen AS lastSeen,
            last_volume AS lastVolume, muted, created_at AS createdAt
       FROM speaker_devices WHERE device_id = ?`,
  );
  const updateStateStmt = db.prepare(
    `UPDATE speaker_devices
        SET last_volume = ?, muted = ?, last_seen = ?
      WHERE device_id = ?`,
  );
  const markSeenStmt = db.prepare(`UPDATE speaker_devices SET last_seen = ? WHERE device_id = ?`);

  function rowFromRaw(raw: unknown): DeviceRow | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as {
      deviceId: string;
      label: string | null;
      lastSeen: number;
      lastVolume: number;
      muted: number;
      createdAt: number;
    };
    return {
      deviceId: r.deviceId,
      label: r.label ?? null,
      lastSeen: Number(r.lastSeen) || 0,
      lastVolume: clamp01(Number(r.lastVolume)),
      muted: Number(r.muted) !== 0,
      createdAt: Number(r.createdAt) || 0,
    };
  }

  return {
    get(deviceId) {
      return rowFromRaw(selectStmt.get(deviceId));
    },
    touch(deviceId, now = Date.now()) {
      // Default volume 0.6 matches the schema; we never persist anything
      // below 0 or above 1 because the device clamps before sending.
      insertStmt.run(deviceId, now, 0.6, 0);
      const row = rowFromRaw(selectStmt.get(deviceId));
      // Should never happen — we just inserted. Defensive cast to make the
      // type checker happy without piling on noise at every caller.
      if (!row) {
        throw new Error(`device row missing after touch: ${deviceId}`);
      }
      return row;
    },
    saveVolumeMuted(deviceId, volume, muted, now = Date.now()) {
      updateStateStmt.run(clamp01(volume), muted ? 1 : 0, now, deviceId);
    },
    markSeen(deviceId, now = Date.now()) {
      markSeenStmt.run(now, deviceId);
    },
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
