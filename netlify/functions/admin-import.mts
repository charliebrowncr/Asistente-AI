import type { Config } from "@netlify/functions";
import { and, eq, gte, lte, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { imports, reservations } from "../../db/schema.js";
import { requireAdmin } from "../../lib/auth.js";
import { parsePdf, parseSpreadsheet, type ParsedReservation } from "../../lib/parse.js";

export default async (req: Request) => {
  const user = await requireAdmin();
  if (user instanceof Response) return user;

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Adjunta un archivo." }, { status: 400 });

  const name = file.name.toLowerCase();
  const ext = name.split(".").pop() ?? "";
  if (!["csv", "xlsx", "xls", "pdf"].includes(ext)) {
    return Response.json({ error: "Formato no soportado. Usa Excel (.xlsx, .xls), CSV o PDF." }, { status: 400 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());

  let parsed: ParsedReservation[];
  try {
    parsed = ext === "pdf" ? await parsePdf(bytes) : parseSpreadsheet(bytes, ext === "csv");
  } catch (e) {
    console.error("import parse failed", e);
    return Response.json({ error: "No se pudo leer el archivo." }, { status: 422 });
  }
  // The same reservation can appear on several sheets; keep the last occurrence.
  parsed = [...new Map(parsed.map((r) => [r.externalId, r])).values()];
  if (!parsed.length) {
    return Response.json(
      { error: "No se encontraron reservas. Revisa que el archivo tenga columnas de huésped y fechas de llegada/salida." },
      { status: 422 },
    );
  }

  const [imp] = await db
    .insert(imports)
    .values({ fileName: file.name, fileType: ext, importedBy: user.email ?? user.id, reservationCount: parsed.length })
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
  if (form.get("sync") === "1") {
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
      .returning({ guestName: reservations.guestName });
    removed = gone.length;
  }

  return Response.json({
    importId: imp.id,
    removed,
    total: parsed.length,
    created,
    updated: parsed.length - created,
    cancelled: parsed.filter((r) => r.status === "cancelled").length,
    withoutCode: parsed.filter((r) => !r.codes.length).map((r) => r.guestName),
  });
};

export const config: Config = { path: "/api/admin/import", method: "POST" };
