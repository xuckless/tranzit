import * as SQLite from "expo-sqlite";

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
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "UPDATE category_places SET is_default = 0 WHERE categoryID = ?",
      categoryId
    );
    await db.runAsync(
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
  await db.withTransactionAsync(async () => {
    if (isDefault) {
      await db.runAsync(
        "UPDATE category_places SET is_default = 0 WHERE categoryID = ?",
        categoryId
      );
    }
    await db.runAsync(
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
