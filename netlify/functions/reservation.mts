import type { Config } from "@netlify/functions";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { reservations } from "../../db/schema.js";
import { normalizeCode } from "../../lib/parse.js";

// Public lookup used by the guest app: confirmation number -> stay details.
// Only what the app needs to greet the guest is returned (no email or amounts).
export default async (req: Request) => {
  const code = normalizeCode(new URL(req.url).searchParams.get("code") ?? "");
  if (code.length < 5) return Response.json({ error: "invalid_code" }, { status: 400 });

  const [r] = await db
    .select()
    .from(reservations)
    .where(and(sql`${code} = ANY(${reservations.codes})`, eq(reservations.status, "booked")))
    .orderBy(desc(reservations.arrival))
    .limit(1);
  if (!r) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json(
    {
      ref: code,
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
