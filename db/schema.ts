import { pgTable, serial, text, timestamp, integer, date, numeric, index } from "drizzle-orm/pg-core";

// One row per reservation. `externalId` is the PMS reservation Id (or the
// channel confirmation when the import has no Id) and is what re-imports
// upsert on. `codes` holds every confirmation number a guest might type,
// normalized to uppercase without spaces.
export const reservations = pgTable(
  "reservations",
  {
    id: serial().primaryKey(),
    externalId: text("external_id").notNull().unique(),
    codes: text().array().notNull().default([]),
    source: text().notNull().default(""),
    status: text().notNull().default("booked"),
    guestName: text("guest_name").notNull(),
    guestEmail: text("guest_email"),
    houseName: text("house_name").notNull().default(""),
    villa: text().notNull().default(""),
    arrival: date().notNull(),
    departure: date().notNull(),
    nights: integer().notNull().default(0),
    guests: integer().notNull().default(0),
    adults: integer().notNull().default(0),
    children: integer().notNull().default(0),
    currency: text().notNull().default("USD"),
    total: numeric({ precision: 12, scale: 2 }),
    importId: integer("import_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("reservations_arrival_idx").on(t.arrival), index("reservations_codes_idx").using("gin", t.codes)],
);

export const imports = pgTable("imports", {
  id: serial().primaryKey(),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  importedBy: text("imported_by"),
  reservationCount: integer("reservation_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
