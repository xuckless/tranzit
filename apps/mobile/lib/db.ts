import * as SQLite from "expo-sqlite";
import type { CalgaryTransitStop } from "@/types/database";

// ─── Saved-place mirror types ──────────────────────────────────────────────────
// Local SQLite mirror of the user DB saved places (one address per category).
// `pending = 1` marks a row written locally but not yet confirmed in the user DB
// (offline / 503); the orchestrator's outbox retries those. Scoped by user_id so
// multiple identities (incl. an anonymous guest) on one device never collide.

export interface SavedPlaceMirrorRow {
  user_id: string;
  category_code: string;
  category_name: string;
  category_icon: string;
  full_formatted_address: string;
  city: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  google_place_id: string | null;
  pending: number;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _db: SQLite.SQLiteDatabase | null = null;
let _openPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return Promise.resolve(_db);
  if (!_openPromise) _openPromise = _openDb();
  return _openPromise;
}

async function _openDb(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync("tranzit.db");
  await db.runAsync("PRAGMA journal_mode = WAL");
  await db.runAsync("PRAGMA foreign_keys = ON");
  await _initSchema(db);
  _db = db;
  return db;
}

async function _initSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  // Saved places now live in the user DB; SQLite only mirrors them for offline
  // reads. Drop the legacy normalized tables (a place could belong to many
  // categories with a per-category default) — incompatible with the new
  // one-address-per-category model, so we start fresh.
  await db.execAsync(`
    DROP TABLE IF EXISTS category_places;
    DROP TABLE IF EXISTS Places;
    DROP TABLE IF EXISTS Category;

    CREATE TABLE IF NOT EXISTS saved_place_cache (
      user_id                TEXT NOT NULL,
      category_code          TEXT NOT NULL,
      category_name          TEXT NOT NULL,
      category_icon          TEXT NOT NULL,
      full_formatted_address TEXT NOT NULL,
      city                   TEXT,
      country                TEXT,
      lat                    REAL,
      lng                    REAL,
      google_place_id        TEXT,
      pending                INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
      PRIMARY KEY (user_id, category_code)
    );
  `);
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_saved_place_user
      ON saved_place_cache (user_id)
  `);

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS transit_stops_cache (
      globalid        TEXT    PRIMARY KEY,
      teleride_number INTEGER,
      stop_name       TEXT,
      status          TEXT,
      point           TEXT,
      cached_at       INTEGER NOT NULL
    )
  `);
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_stops_teleride
      ON transit_stops_cache (teleride_number)
  `);
}

// ─── Saved-place mirror (offline cache of the user DB) ──────────────────────────

const SAVED_COLS = `user_id, category_code, category_name, category_icon,
            full_formatted_address, city, country, lat, lng, google_place_id, pending`;

export async function mirrorReadSavedPlaces(
  userId: string
): Promise<SavedPlaceMirrorRow[]> {
  const db = await getDb();
  return db.getAllAsync<SavedPlaceMirrorRow>(
    `SELECT ${SAVED_COLS} FROM saved_place_cache
      WHERE user_id = ? ORDER BY category_name ASC`,
    userId
  );
}

export async function mirrorReadPending(
  userId: string
): Promise<SavedPlaceMirrorRow[]> {
  const db = await getDb();
  return db.getAllAsync<SavedPlaceMirrorRow>(
    `SELECT ${SAVED_COLS} FROM saved_place_cache
      WHERE user_id = ? AND pending = 1`,
    userId
  );
}

export async function mirrorUpsertSavedPlace(
  row: SavedPlaceMirrorRow
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO saved_place_cache
       (user_id, category_code, category_name, category_icon,
        full_formatted_address, city, country, lat, lng, google_place_id, pending)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, category_code) DO UPDATE SET
       category_name          = excluded.category_name,
       category_icon          = excluded.category_icon,
       full_formatted_address = excluded.full_formatted_address,
       city                   = excluded.city,
       country                = excluded.country,
       lat                    = excluded.lat,
       lng                    = excluded.lng,
       google_place_id        = excluded.google_place_id,
       pending                = excluded.pending`,
    row.user_id,
    row.category_code,
    row.category_name,
    row.category_icon,
    row.full_formatted_address,
    row.city,
    row.country,
    row.lat,
    row.lng,
    row.google_place_id,
    row.pending
  );
}

export async function mirrorClearPending(
  userId: string,
  categoryCode: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE saved_place_cache SET pending = 0 WHERE user_id = ? AND category_code = ?",
    userId,
    categoryCode
  );
}

export async function mirrorDeleteSavedPlace(
  userId: string,
  categoryCode: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "DELETE FROM saved_place_cache WHERE user_id = ? AND category_code = ?",
    userId,
    categoryCode
  );
}

/**
 * Replace the mirror for a user with the authoritative remote rows, but never
 * clobber rows still pending a remote write (offline saves stay until pushed).
 */
export async function mirrorReplaceAll(
  userId: string,
  rows: SavedPlaceMirrorRow[]
): Promise<void> {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      "DELETE FROM saved_place_cache WHERE user_id = ? AND pending = 0",
      userId
    );
    for (const r of rows) {
      await txn.runAsync(
        `INSERT INTO saved_place_cache
           (user_id, category_code, category_name, category_icon,
            full_formatted_address, city, country, lat, lng, google_place_id, pending)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(user_id, category_code) DO UPDATE SET
           category_name          = excluded.category_name,
           category_icon          = excluded.category_icon,
           full_formatted_address = excluded.full_formatted_address,
           city                   = excluded.city,
           country                = excluded.country,
           lat                    = excluded.lat,
           lng                    = excluded.lng,
           google_place_id        = excluded.google_place_id,
           pending                = 0`,
        r.user_id,
        r.category_code,
        r.category_name,
        r.category_icon,
        r.full_formatted_address,
        r.city,
        r.country,
        r.lat,
        r.lng,
        r.google_place_id
      );
    }
  });
}

// ─── Transit Stops Cache ──────────────────────────────────────────────────────

const STOPS_TTL_SECONDS = 24 * 60 * 60;

export async function getCachedTransitStops(): Promise<CalgaryTransitStop[] | null> {
  const db = await getDb();
  const meta = await db.getFirstAsync<{ oldest: number | null }>(
    "SELECT MIN(cached_at) AS oldest FROM transit_stops_cache"
  );
  if (!meta?.oldest) return null;
  if (Math.floor(Date.now() / 1000) - meta.oldest > STOPS_TTL_SECONDS) return null;
  const rows = await db.getAllAsync<{
    globalid: string;
    teleride_number: number | null;
    stop_name: string | null;
    status: string | null;
    point: string | null;
  }>("SELECT globalid, teleride_number, stop_name, status, point FROM transit_stops_cache");
  return rows.map((r) => ({ ...r, create_dt_utc: null, mod_dt_utc: null }));
}

export async function cacheTransitStops(stops: CalgaryTransitStop[]): Promise<void> {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync("DELETE FROM transit_stops_cache");
    for (const s of stops) {
      await txn.runAsync(
        `INSERT OR REPLACE INTO transit_stops_cache
           (globalid, teleride_number, stop_name, status, point, cached_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        s.globalid,
        s.teleride_number ?? null,
        s.stop_name ?? null,
        s.status ?? null,
        s.point ?? null,
        now,
      );
    }
  });
}

export async function getStopNamesByTelerideNumbers(
  ids: number[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const db = await getDb();
  const ph = ids.map(() => "?").join(",");
  const rows = await db.getAllAsync<{ teleride_number: number; stop_name: string | null }>(
    `SELECT teleride_number, stop_name FROM transit_stops_cache WHERE teleride_number IN (${ph})`,
    ...ids
  );
  return new Map(rows.map((r) => [String(r.teleride_number), r.stop_name ?? `Stop ${r.teleride_number}`]));
}

export async function getStopsByTelerideNumbers(
  ids: number[]
): Promise<CalgaryTransitStop[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const ph = ids.map(() => "?").join(",");
  const rows = await db.getAllAsync<{
    globalid: string;
    teleride_number: number | null;
    stop_name: string | null;
    status: string | null;
    point: string | null;
  }>(
    `SELECT globalid, teleride_number, stop_name, status, point
       FROM transit_stops_cache
      WHERE teleride_number IN (${ph})`,
    ...ids
  );
  return rows.map((r) => ({ ...r, create_dt_utc: null, mod_dt_utc: null }));
}
