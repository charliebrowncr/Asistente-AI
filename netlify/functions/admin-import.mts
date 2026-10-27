import type { Config } from "@netlify/functions";
import { requireAdmin } from "../../lib/auth.js";
import { saveImport } from "../../lib/importer.js";
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

  const result = await saveImport(parsed, {
    fileName: file.name,
    fileType: ext,
    importedBy: user.email ?? user.id,
    sync: form.get("sync") === "1",
  });
  return Response.json(result);
};

export const config: Config = { path: "/api/admin/import", method: "POST" };
