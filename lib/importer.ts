import { and, eq, gte, lte, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { imports, reservations } from "../db/schema.js";
import type { ParsedReservation } from "./parse.js";

type ImportMeta = { fileName: string; fileType: string; importedBy: string; sync: boolean };

/** Upserts parsed reservations and, in sync mode, cancels the ones the file no longer contains. */
export async function saveImport(parsed: ParsedReservation[], meta: ImportMeta) {
  const [imp] = await db
    .insert(imports)
    .values({ fileName: meta.fileName, fileType: meta.fileType, importedBy: meta.importedBy, reservationCount: parsed.length })
    .returning();

  const rows = parsed.map((r) => ({ ...r, importId: imp.id, updatedAt: new Date() }));
  const set = Object.fromEntries(
    Object.keys(rows[0])
      .filter((k) => k !== "externalId")
      .map((k) => [k, sql.raw(`excluded."${reservations[k as keyof typeof reservations.$inferInsert].name}"`)]),
  );
  let created = 0;
  // Batches keep each statement well under Postgres' bind-parameter limit.
  for (let i = 0; i < rows.length; i += 500) {
    const result = await db
      .insert(reservations)
      .values(rows.slice(i, i + 500))
      .onConflictDoUpdate({ target: reservations.externalId, set })
      // xmax = 0 only for freshly inserted rows, which lets us report new vs. updated.
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    created += result.filter((r) => r.inserted).length;
  }

  // Sync mode: the file is the source of truth for the dates it covers. Booked
  // reservations arriving in that range that this import didn't touch are no
  // longer in the PMS, so they are marked cancelled (never deleted).
  let removed = 0;
  if (meta.sync) {
    const arrivals = parsed.map((r) => r.arrival).sort();
    const gone = await db
      .update(reservations)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(reservations.status, "booked"),
          gte(reservations.arrival, arrivals[0]),
          lte(reservations.arrival, arrivals[arrivals.length - 1]),
          ne(reservations.importId, imp.id),
        ),
      )
      .returning({ id: reservations.id });
    removed = gone.length;
  }

  return {
    importId: imp.id,
    removed,
    total: parsed.length,
    created,
    updated: parsed.length - created,
    cancelled: parsed.filter((r) => r.status === "cancelled").length,
    withoutCode: parsed.filter((r) => !r.codes.length).map((r) => r.guestName),
  };
}
