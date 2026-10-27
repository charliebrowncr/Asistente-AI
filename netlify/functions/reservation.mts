import type { Config } from "@netlify/functions";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { reservations } from "../../db/schema.js";
import { normalizeCode } from "../../lib/parse.js";

const words = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);

// Public lookup used by the guest app, either by confirmation number or by
// last name + arrival date. Only what the app needs to greet the guest is
// returned (no email or amounts); a name lookup never reveals the confirmation code.
export default async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const code = normalizeCode(params.get("code") ?? "");
  const name = words(params.get("name") ?? "");
  const arrival = params.get("arrival") ?? "";

  let r: typeof reservations.$inferSelect | undefined;
  if (code) {
    if (code.length < 5) return Response.json({ error: "invalid_code" }, { status: 400 });
    [r] = await db
      .select()
      .from(reservations)
      .where(and(sql`${code} = ANY(${reservations.codes})`, eq(reservations.status, "booked")))
      .orderBy(desc(reservations.arrival))
      .limit(1);
  } else if (name.length && /^\d{4}-\d{2}-\d{2}$/.test(arrival)) {
    const sameDay = await db
      .select()
      .from(reservations)
      .where(and(eq(reservations.arrival, arrival), eq(reservations.status, "booked")));
    // Every word typed must be one of the guest's names; ambiguous matches are rejected.
    const hits = sameDay.filter((x) => {
      const g = words(x.guestName);
      return name.every((w) => g.includes(w));
    });
    if (hits.length === 1) r = hits[0];
  } else {
    return Response.json({ error: "invalid_query" }, { status: 400 });
  }
  if (!r) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json(
    {
      ref: code || null,
      guestName: r.guestName,
      villa: r.villa,
      houseName: r.houseName,
      arrival: r.arrival,
      departure: r.departure,
      nights: r.nights,
      guests: r.guests,
      source: r.source,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
};

export const config: Config = { path: "/api/reservation", method: "GET" };
