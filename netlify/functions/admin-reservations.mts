import type { Config } from "@netlify/functions";
import { and, asc, desc, gt, lt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { imports, reservations } from "../../db/schema.js";
import { requireAdmin } from "../../lib/auth.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Reservations overlapping [from, to) plus the latest imports.
export default async (req: Request) => {
  const user = await requireAdmin();
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!ISO.test(from) || !ISO.test(to)) return Response.json({ error: "Rango de fechas inválido." }, { status: 400 });

  const [list, recentImports] = await Promise.all([
    db
      .select()
      .from(reservations)
      .where(and(lt(reservations.arrival, to), gt(reservations.departure, from)))
      .orderBy(asc(reservations.arrival)),
    db.select().from(imports).orderBy(desc(imports.createdAt)).limit(5),
  ]);
  return Response.json({ reservations: list, imports: recentImports });
};

export const config: Config = { path: "/api/admin/reservations", method: "GET" };
