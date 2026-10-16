import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { tool } from "langchain";
import { z } from "zod";
import { seedHotels, seedHotelPrices, seedBnbs } from "./seed_data.js";

// =============================================================================
// Interfaces & Types
// =============================================================================

export interface HotelOffer {
  hotel_name: string;
  town: string;
  address: string;
  rating: number;
  available_rooms: number;
  room_type: "single" | "double";
  price_per_night_gbp: number;
}

export interface BnBOffer {
  bnb_id: number;
  bnb_name: string;
  town: string;
  available_rooms: number;
  price_per_room_gbp: number;
}

// =============================================================================
// SQLite Database Setup
// =============================================================================
// Uses Node 22's native `node:sqlite` (DatabaseSync).
// Database file is stored persistently at: data/cornwall_hotels.db

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const databasePath = resolve(moduleDirectory, "../data/cornwall_hotels.db");
mkdirSync(dirname(databasePath), { recursive: true });

export const database = new DatabaseSync(databasePath);

/**
 * Initializes database tables and inserts seed records if empty.
 */
function initDatabase(): void {
  // 1. Enable foreign keys and create tables
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS hotels (
      hotel_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_name  TEXT    NOT NULL,
      town        TEXT    NOT NULL,
      address     TEXT    NOT NULL,
      rating      REAL    NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS hotel_room_offers (
      offer_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id        INTEGER NOT NULL,
      available_rooms INTEGER NOT NULL,
      price_single    REAL    NOT NULL,
      price_double    REAL    NOT NULL,
      FOREIGN KEY (hotel_id) REFERENCES hotels(hotel_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bnbs (
      bnb_id          INTEGER PRIMARY KEY AUTOINCREMENT,
      bnb_name        TEXT    NOT NULL,
      town            TEXT    NOT NULL,
      available_rooms INTEGER NOT NULL,
      price_per_room  REAL    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hotels_town ON hotels(town);
    CREATE INDEX IF NOT EXISTS idx_bnbs_town ON bnbs(town);
  `);

  // 2. Seed hotels and room offers if the table is empty
  const hotelCount = Number(
    database.prepare("SELECT COUNT(*) AS count FROM hotels").get()?.count ?? 0,
  );
  if (hotelCount === 0) {
    const insertHotel = database.prepare(
      `INSERT INTO hotels (hotel_name, town, address, rating, description)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertOffer = database.prepare(
      `INSERT INTO hotel_room_offers (hotel_id, available_rooms, price_single, price_double)
       VALUES (?, ?, ?, ?)`,
    );

    database.exec("BEGIN");
    try {
      seedHotels.forEach((hotel, index) => {
        const result = insertHotel.run(...hotel);
        insertOffer.run(Number(result.lastInsertRowid), ...seedHotelPrices[index]);
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  // 3. Seed BnBs if the table is empty
  const bnbCount = Number(
    database.prepare("SELECT COUNT(*) AS count FROM bnbs").get()?.count ?? 0,
  );
  if (bnbCount === 0) {
    const insertBnb = database.prepare(
      `INSERT INTO bnbs (bnb_name, town, available_rooms, price_per_room)
       VALUES (?, ?, ?, ?)`,
    );

    database.exec("BEGIN");
    try {
      seedBnbs.forEach((bnb) => insertBnb.run(...bnb));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

// Run table creation and initial seeding
initDatabase();

// =============================================================================
// SQLite Query Functions
// =============================================================================

/**
 * Queries hotels and room offers in SQLite matching town and minimum room count.
 */
export function findHotelOffers(
  town: string,
  rooms: number,
  roomType: "single" | "double",
): HotelOffer[] {
  const priceColumn = roomType === "single" ? "price_single" : "price_double";
  const statement = database.prepare(`
    SELECT h.hotel_name, h.town, h.address, h.rating,
           offer.available_rooms, offer.${priceColumn} AS price_per_night_gbp
    FROM hotels AS h
    JOIN hotel_room_offers AS offer ON offer.hotel_id = h.hotel_id
    WHERE lower(h.town) = lower(?) AND offer.available_rooms >= ?
    ORDER BY price_per_night_gbp ASC
  `);

  return statement.all(town.trim(), rooms).map((row) => ({
    hotel_name: String(row.hotel_name),
    town: String(row.town),
    address: String(row.address),
    rating: Number(row.rating),
    available_rooms: Number(row.available_rooms),
    room_type: roomType,
    price_per_night_gbp: Number(row.price_per_night_gbp),
  }));
}

/**
 * Queries BnB listings in SQLite matching town and minimum room count.
 */
export function findBnbOffers(town: string, rooms: number): BnBOffer[] {
  const statement = database.prepare(`
    SELECT bnb_id, bnb_name, town, available_rooms,
           price_per_room AS price_per_room_gbp
    FROM bnbs
    WHERE lower(town) = lower(?) AND available_rooms >= ?
    ORDER BY price_per_room ASC
  `);

  return statement.all(town.trim(), rooms).map((row) => ({
    bnb_id: Number(row.bnb_id),
    bnb_name: String(row.bnb_name),
    town: String(row.town),
    available_rooms: Number(row.available_rooms),
    price_per_room_gbp: Number(row.price_per_room_gbp),
  }));
}

// =============================================================================
// LangChain Tools for Agents
// =============================================================================

export const hotelAvailabilityTool = tool(
  ({ destination, num_rooms, room_type }) => {
    const offers = findHotelOffers(destination, num_rooms, room_type);
    return JSON.stringify(
      offers.length > 0
        ? offers
        : { message: `No ${room_type}-room hotel offers in ${destination} have at least ${num_rooms} rooms available.` },
      null,
      2,
    );
  },
  {
    name: "check_hotel_availability",
    description:
      "Check hotel room availability and nightly price in a Cornwall town. Queries the SQLite database (hotels + hotel_room_offers tables).",
    schema: z.object({
      destination: z.string().min(2).describe("Town or city in Cornwall, e.g., 'Newquay', 'Falmouth', 'St Ives'"),
      num_rooms: z.number().int().min(1).max(20).default(1).describe("Number of rooms required"),
      room_type: z.enum(["single", "double"]).default("double").describe("Room type: 'single' or 'double'"),
    }),
  },
);

export const bnbAvailabilityTool = tool(
  ({ destination, num_rooms }) => {
    const offers = findBnbOffers(destination, num_rooms);
    return JSON.stringify(
      offers.length > 0
        ? offers
        : { message: `No BnB offers found in ${destination} with at least ${num_rooms} rooms available.` },
      null,
      2,
    );
  },
  {
    name: "check_bnb_availability",
    description:
      "Check Bed & Breakfast room availability and nightly price in a Cornwall town. Queries the SQLite database (bnbs table).",
    schema: z.object({
      destination: z.string().min(2).describe("Town or city in Cornwall, e.g., 'Newquay', 'Falmouth', 'St Ives'"),
      num_rooms: z.number().int().min(1).max(20).default(1).describe("Number of rooms required"),
    }),
  },
);
