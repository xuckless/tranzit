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

// ─── Search-history mirror types ────────────────────────────────────────────────
// Local SQLite mirror of the user DB `user_history`. It doubles as the outbox:
// `pending = 1` marks a search recorded locally but not yet confirmed in the user
// DB (offline / 503), retried by the orchestrator. The (user_id, place_key) PK
// gives free per-place dedup — re-searching a place updates its row and bumps
// date_time. Scoped by user_id so multiple identities never collide.

export interface SearchHistoryMirrorRow {
  user_id: string;
  place_key: string;
  google_place_id: string | null;
  common_name: string | null;
  destination_full_formatted_address: string;
  destination_city: string | null;
  destination_country: string | null;
  destination_lat: number | null;
  destination_lng: number | null;
  origin_lat: number | null;
  origin_lng: number | null;
  origin_address: string | null;
  category_code: string | null;
  date_time: string; // ISO; used for ordering/cap
  pending: number;
}

// ─── Planner-event mirror types ─────────────────────────────────────────────────
// Local SQLite mirror of the user DB `user_defined_events`. Doubles as the outbox:
// `pending = 1` marks an event written locally but not yet confirmed in the user DB
// (offline / 503), retried by the orchestrator. (user_id, event_id) PK matches the
// remote PK so saves UPSERT in place. travel_time/recurrence_rule are deferred and
// not mirrored. Scoped by user_id so multiple identities never collide.

export interface PlannedEventMirrorRow {
  user_id: string;
  event_id: string;
  name: string;
  description: string | null;
  location: string | null;
  start_time: string; // ISO
  end_time: string; // ISO
  timezone: string | null;
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

  // Search history mirror / outbox (one row per recently-searched place, deduped
  // by place_key, capped to the newest N per user by the orchestrator).
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS search_history_cache (
      user_id                            TEXT NOT NULL,
      place_key                          TEXT NOT NULL,
      google_place_id                    TEXT,
      common_name                        TEXT,
      destination_full_formatted_address TEXT NOT NULL,
      destination_city                   TEXT,
      destination_country                TEXT,
      destination_lat                    REAL,
      destination_lng                    REAL,
      origin_lat                         REAL,
      origin_lng                         REAL,
      origin_address                     TEXT,
      category_code                      TEXT,
      date_time                          TEXT NOT NULL,
      pending                            INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
      PRIMARY KEY (user_id, place_key)
    );
  `);
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_search_history_user
      ON search_history_cache (user_id, date_time)
  `);
  // Add common_name to mirrors created before the column existed (idempotent).
  await _addColumnIfMissing(db, "search_history_cache", "common_name", "TEXT");

  // Planner events mirror / outbox (one row per user_defined_events row).
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS planner_event_cache (
      user_id     TEXT NOT NULL,
      event_id    TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      location    TEXT,
      start_time  TEXT NOT NULL,
      end_time    TEXT NOT NULL,
      timezone    TEXT,
      pending     INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
      PRIMARY KEY (user_id, event_id)
    );
  `);
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_planner_event_user
      ON planner_event_cache (user_id, start_time)
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

/** Add a column to an existing table if it isn't there yet (SQLite has no
 *  IF NOT EXISTS for ADD COLUMN). Idempotent across launches. */
async function _addColumnIfMissing(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  const cols = await db.getAllAsync<{ name: string }>(
    `PRAGMA table_info(${table})`,
  );
  if (!cols.some((c) => c.name === column)) {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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

// ─── Search-history mirror (offline outbox of the user DB) ──────────────────────

const SEARCH_COLS = `user_id, place_key, google_place_id, common_name,
            destination_full_formatted_address, destination_city, destination_country,
            destination_lat, destination_lng, origin_lat, origin_lng, origin_address,
            category_code, date_time, pending`;

export async function mirrorUpsertSearch(
  row: SearchHistoryMirrorRow
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO search_history_cache
       (user_id, place_key, google_place_id, common_name,
        destination_full_formatted_address, destination_city, destination_country,
        destination_lat, destination_lng, origin_lat, origin_lng, origin_address,
        category_code, date_time, pending)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, place_key) DO UPDATE SET
       google_place_id                    = excluded.google_place_id,
       common_name                        = excluded.common_name,
       destination_full_formatted_address = excluded.destination_full_formatted_address,
       destination_city                   = excluded.destination_city,
       destination_country                = excluded.destination_country,
       destination_lat                    = excluded.destination_lat,
       destination_lng                    = excluded.destination_lng,
       origin_lat                         = excluded.origin_lat,
       origin_lng                         = excluded.origin_lng,
       origin_address                     = excluded.origin_address,
       category_code                      = excluded.category_code,
       date_time                          = excluded.date_time,
       pending                            = excluded.pending`,
    row.user_id,
    row.place_key,
    row.google_place_id,
    row.common_name,
    row.destination_full_formatted_address,
    row.destination_city,
    row.destination_country,
    row.destination_lat,
    row.destination_lng,
    row.origin_lat,
    row.origin_lng,
    row.origin_address,
    row.category_code,
    row.date_time,
    row.pending
  );
}

export async function mirrorReadPendingSearch(
  userId: string
): Promise<SearchHistoryMirrorRow[]> {
  const db = await getDb();
  return db.getAllAsync<SearchHistoryMirrorRow>(
    `SELECT ${SEARCH_COLS} FROM search_history_cache
      WHERE user_id = ? AND pending = 1 ORDER BY date_time ASC`,
    userId
  );
}

export async function mirrorClearPendingSearch(
  userId: string,
  placeKey: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE search_history_cache SET pending = 0 WHERE user_id = ? AND place_key = ?",
    userId,
    placeKey
  );
}

/** Trim the mirror to the newest `limit` rows for a user (by date_time). */
export async function mirrorCapSearch(
  userId: string,
  limit: number
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `DELETE FROM search_history_cache
      WHERE user_id = ?
        AND place_key NOT IN (
          SELECT place_key FROM search_history_cache
           WHERE user_id = ? ORDER BY date_time DESC LIMIT ?
        )`,
    userId,
    userId,
    limit
  );
}

/** Read the newest `limit` searches for display (regardless of pending state). */
export async function mirrorListRecentSearch(
  userId: string,
  limit: number
): Promise<SearchHistoryMirrorRow[]> {
  const db = await getDb();
  return db.getAllAsync<SearchHistoryMirrorRow>(
    `SELECT ${SEARCH_COLS} FROM search_history_cache
      WHERE user_id = ? ORDER BY date_time DESC LIMIT ?`,
    userId,
    limit
  );
}

/**
 * Replace the mirror for a user with the authoritative remote rows, but never
 * clobber rows still pending a remote write (offline records stay until pushed).
 */
export async function mirrorReplaceAllSearch(
  userId: string,
  rows: SearchHistoryMirrorRow[]
): Promise<void> {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      "DELETE FROM search_history_cache WHERE user_id = ? AND pending = 0",
      userId
    );
    for (const r of rows) {
      await txn.runAsync(
        `INSERT INTO search_history_cache
           (user_id, place_key, google_place_id, common_name,
            destination_full_formatted_address, destination_city, destination_country,
            destination_lat, destination_lng, origin_lat, origin_lng, origin_address,
            category_code, date_time, pending)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(user_id, place_key) DO UPDATE SET
           google_place_id                    = excluded.google_place_id,
           common_name                        = excluded.common_name,
           destination_full_formatted_address = excluded.destination_full_formatted_address,
           destination_city                   = excluded.destination_city,
           destination_country                = excluded.destination_country,
           destination_lat                    = excluded.destination_lat,
           destination_lng                    = excluded.destination_lng,
           origin_lat                         = excluded.origin_lat,
           origin_lng                         = excluded.origin_lng,
           origin_address                     = excluded.origin_address,
           category_code                      = excluded.category_code,
           date_time                          = excluded.date_time,
           pending                            = 0`,
        r.user_id,
        r.place_key,
        r.google_place_id,
        r.common_name,
        r.destination_full_formatted_address,
        r.destination_city,
        r.destination_country,
        r.destination_lat,
        r.destination_lng,
        r.origin_lat,
        r.origin_lng,
        r.origin_address,
        r.category_code,
        r.date_time
      );
    }
  });
}

// ─── Planner-event mirror (offline cache / outbox of the user DB) ───────────────

const EVENT_COLS = `user_id, event_id, name, description, location,
            start_time, end_time, timezone, pending`;

export async function mirrorReadEvents(
  userId: string
): Promise<PlannedEventMirrorRow[]> {
  const db = await getDb();
  return db.getAllAsync<PlannedEventMirrorRow>(
    `SELECT ${EVENT_COLS} FROM planner_event_cache
      WHERE user_id = ? ORDER BY start_time ASC`,
    userId
  );
}

export async function mirrorReadPendingEvents(
  userId: string
): Promise<PlannedEventMirrorRow[]> {
  const db = await getDb();
  return db.getAllAsync<PlannedEventMirrorRow>(
    `SELECT ${EVENT_COLS} FROM planner_event_cache
      WHERE user_id = ? AND pending = 1 ORDER BY start_time ASC`,
    userId
  );
}

export async function mirrorUpsertEvent(
  row: PlannedEventMirrorRow
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO planner_event_cache
       (user_id, event_id, name, description, location,
        start_time, end_time, timezone, pending)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, event_id) DO UPDATE SET
       name        = excluded.name,
       description = excluded.description,
       location    = excluded.location,
       start_time  = excluded.start_time,
       end_time    = excluded.end_time,
       timezone    = excluded.timezone,
       pending     = excluded.pending`,
    row.user_id,
    row.event_id,
    row.name,
    row.description,
    row.location,
    row.start_time,
    row.end_time,
    row.timezone,
    row.pending
  );
}

export async function mirrorClearPendingEvent(
  userId: string,
  eventId: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE planner_event_cache SET pending = 0 WHERE user_id = ? AND event_id = ?",
    userId,
    eventId
  );
}

export async function mirrorDeleteEvent(
  userId: string,
  eventId: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "DELETE FROM planner_event_cache WHERE user_id = ? AND event_id = ?",
    userId,
    eventId
  );
}

/**
 * Replace the mirror for a user with the authoritative remote rows, but never
 * clobber rows still pending a remote write (offline saves stay until pushed).
 */
export async function mirrorReplaceAllEvents(
  userId: string,
  rows: PlannedEventMirrorRow[]
): Promise<void> {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      "DELETE FROM planner_event_cache WHERE user_id = ? AND pending = 0",
      userId
    );
    for (const r of rows) {
      await txn.runAsync(
        `INSERT INTO planner_event_cache
           (user_id, event_id, name, description, location,
            start_time, end_time, timezone, pending)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(user_id, event_id) DO UPDATE SET
           name        = excluded.name,
           description = excluded.description,
           location    = excluded.location,
           start_time  = excluded.start_time,
           end_time    = excluded.end_time,
           timezone    = excluded.timezone,
           pending     = 0`,
        r.user_id,
        r.event_id,
        r.name,
        r.description,
        r.location,
        r.start_time,
        r.end_time,
        r.timezone
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
