import * as SQLite from "expo-sqlite";
import type { CalgaryTransitStop } from "@/types/database";

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface SavedPlace {
  googlePlaceId: string;
  address: string;
  latitude: number;
  longitude: number;
  label: string | null;
  isDefault: boolean;
}

export interface CategoryWithPlaces {
  id: number;
  catName: string;
  places: SavedPlace[];
}

export interface QuickAccessPlace {
  categoryId: number;
  categoryName: string;
  googlePlaceId: string;
  address: string;
  latitude: number;
  longitude: number;
  label: string | null;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _db: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync("tranzit.db");
  await _db.runAsync("PRAGMA journal_mode = WAL");
  await _db.runAsync("PRAGMA foreign_keys = ON");
  await _initSchema(_db);
  return _db;
}

async function _initSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS Category (
      Id      INTEGER PRIMARY KEY AUTOINCREMENT,
      catName TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Places (
      GooglePlaceId TEXT PRIMARY KEY,
      Address       TEXT NOT NULL,
      Latitude      REAL NOT NULL,
      Longitude     REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS category_places (
      categoryID   INTEGER NOT NULL,
      PlaceID      TEXT    NOT NULL,
      categoryName TEXT    NOT NULL,
      label        TEXT,
      is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      PRIMARY KEY (categoryID, PlaceID),
      FOREIGN KEY (categoryID) REFERENCES Category (Id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (PlaceID)    REFERENCES Places (GooglePlaceId) ON DELETE CASCADE ON UPDATE CASCADE
    );
  `);

  // Partial unique index: at most one is_default=1 row per category.
  // Must be a separate exec — SQLite doesn't support CREATE INDEX inside a
  // multi-statement string that also contains CREATE TABLE.
  await db.execAsync(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_one_default_per_category
      ON category_places (categoryID)
      WHERE is_default = 1
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

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getAllCategories(): Promise<
  Array<{ id: number; catName: string }>
> {
  const db = await getDb();
  return db.getAllAsync<{ id: number; catName: string }>(
    "SELECT Id as id, catName FROM Category ORDER BY catName ASC"
  );
}

type RawPlaceRow = {
  categoryId: number;
  catName: string;
  googlePlaceId: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  label: string | null;
  isDefault: number | null;
};

export async function getSavedPlacesGrouped(): Promise<CategoryWithPlaces[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<RawPlaceRow>(`
    SELECT
      c.Id            AS categoryId,
      c.catName,
      p.GooglePlaceId AS googlePlaceId,
      p.Address       AS address,
      p.Latitude      AS latitude,
      p.Longitude     AS longitude,
      cp.label,
      cp.is_default   AS isDefault
    FROM Category c
    LEFT JOIN category_places cp ON cp.categoryID = c.Id
    LEFT JOIN Places p           ON p.GooglePlaceId = cp.PlaceID
    ORDER BY c.Id, cp.is_default DESC, cp.label ASC
  `);

  const map = new Map<number, CategoryWithPlaces>();
  for (const row of rows) {
    if (!map.has(row.categoryId)) {
      map.set(row.categoryId, {
        id: row.categoryId,
        catName: row.catName,
        places: [],
      });
    }
    if (row.googlePlaceId != null) {
      map.get(row.categoryId)!.places.push({
        googlePlaceId: row.googlePlaceId,
        address: row.address!,
        latitude: row.latitude!,
        longitude: row.longitude!,
        label: row.label,
        isDefault: row.isDefault === 1,
      });
    }
  }
  return Array.from(map.values());
}

export async function getDefaultPlaces(): Promise<QuickAccessPlace[]> {
  const db = await getDb();
  return db.getAllAsync<QuickAccessPlace>(`
    SELECT
      c.Id            AS categoryId,
      cp.categoryName,
      cp.label,
      p.GooglePlaceId AS googlePlaceId,
      p.Address       AS address,
      p.Latitude      AS latitude,
      p.Longitude     AS longitude
    FROM category_places cp
    JOIN Category c ON c.Id = cp.categoryID
    JOIN Places p   ON p.GooglePlaceId = cp.PlaceID
    WHERE cp.is_default = 1
    ORDER BY c.Id
  `);
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export async function setDefaultPlace(
  categoryId: number,
  placeId: string
): Promise<void> {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      "UPDATE category_places SET is_default = 0 WHERE categoryID = ?",
      categoryId
    );
    await txn.runAsync(
      "UPDATE category_places SET is_default = 1 WHERE categoryID = ? AND PlaceID = ?",
      categoryId,
      placeId
    );
  });
}

export async function insertCategory(catName: string): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    "INSERT INTO Category (catName) VALUES (?)",
    catName
  );
  return result.lastInsertRowId;
}

export async function upsertPlace(
  googlePlaceId: string,
  address: string,
  latitude: number,
  longitude: number
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO Places (GooglePlaceId, Address, Latitude, Longitude)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(GooglePlaceId) DO UPDATE SET
       Address   = excluded.Address,
       Latitude  = excluded.Latitude,
       Longitude = excluded.Longitude`,
    googlePlaceId,
    address,
    latitude,
    longitude
  );
}

export async function linkPlaceToCategory(
  categoryId: number,
  categoryName: string,
  placeId: string,
  label: string | null,
  isDefault: boolean
): Promise<void> {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    if (isDefault) {
      await txn.runAsync(
        "UPDATE category_places SET is_default = 0 WHERE categoryID = ?",
        categoryId
      );
    }
    await txn.runAsync(
      `INSERT INTO category_places (categoryID, PlaceID, categoryName, label, is_default)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(categoryID, PlaceID) DO UPDATE SET
         label      = excluded.label,
         is_default = excluded.is_default`,
      categoryId,
      placeId,
      categoryName,
      label,
      isDefault ? 1 : 0
    );
  });
}

export async function removePlaceFromCategory(
  categoryId: number,
  placeId: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "DELETE FROM category_places WHERE categoryID = ? AND PlaceID = ?",
    categoryId,
    placeId
  );
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
