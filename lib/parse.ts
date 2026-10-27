import * as XLSX from "xlsx";
import Anthropic from "@anthropic-ai/sdk";

export type ParsedReservation = {
  externalId: string;
  codes: string[];
  source: string;
  status: "booked" | "cancelled";
  guestName: string;
  guestEmail: string | null;
  houseName: string;
  villa: string;
  arrival: string; // YYYY-MM-DD
  departure: string; // YYYY-MM-DD
  nights: number;
  guests: number;
  adults: number;
  children: number;
  currency: string;
  total: string | null;
};

// Header aliases (normalized: lowercase, no accents, alphanumeric only).
// Covers the OTC/PMS export plus common Spanish/English variants.
const FIELDS: Record<string, string[]> = {
  id: ["id", "reservationid", "bookingid", "idreserva"],
  source: ["source", "channel", "canal", "origen", "plataforma"],
  sourceText: ["sourcetext"],
  confirmation: [
    "channelbooking", "confirmation", "confirmationnumber", "confirmationcode", "confirmacion",
    "numeroconfirmacion", "numerodeconfirmacion", "codigo", "reservationnumber", "bookingnumber",
    "reference", "referencia", "reserva", "numeroreserva",
  ],
  status: ["status", "estado"],
  cancelled: ["datecancelled", "cancelled", "cancelado", "fechacancelacion"],
  arrival: ["datearrival", "arrival", "checkin", "llegada", "entrada", "fechallegada", "fechaentrada"],
  departure: ["datedeparture", "departure", "checkout", "salida", "fechasalida"],
  nights: ["nights", "noches"],
  house: ["housename", "house", "property", "propiedad", "villa", "unit", "unidad", "roomtypenames", "habitacion"],
  guest: ["guestname", "guest", "name", "nombre", "huesped", "cliente", "nombrehuesped"],
  email: ["guestemail", "email", "correo", "mail"],
  guests: ["numberofguests", "guests", "personas", "pax", "huespedes", "ocupantes"],
  adults: ["adults", "adultos"],
  children: ["children", "ninos"],
  currency: ["currency", "moneda"],
  amount: ["grossamount", "total", "amount", "monto", "importe", "precio"],
};

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const VILLAS = [
  "Toucan", "Lapa", "Oropendola", "Caracara", "Iguana", "Torogoz", "Quetzal", "Salamandra",
  "Rana", "Cusinga", "Gecko", "Lizardo", "Pavon", "Loro", "Tortuga", "Love Nest",
];

export function villaFromHouse(house: string): string {
  // Whole-word match, so "villa | Pavon" isn't read as "Lapa".
  const h = " " + house.split(/[^\p{L}\p{N}]+/u).map(norm).join(" ") + " ";
  for (const v of VILLAS) if (h.includes(" " + v.split(" ").map(norm).join(" ") + " ")) return v;
  return (house.split("|")[0] || house).trim();
}

export function codesFrom(...values: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    for (const token of String(v ?? "").split(/[|,;/\s]+/)) {
      const t = token.toUpperCase().replace(/[^A-Z0-9-]/g, "");
      if (t.length >= 5 && /\d|^[A-Z]{2}[A-Z0-9]{6,}$/.test(t) && !token.includes(".")) out.add(t);
    }
  }
  return [...out];
}

// The internal PMS Id is sequential and easy to guess, so it only counts as a
// guest-facing code when the reservation has no channel confirmation (e.g.
// direct website bookings, whose confirmation email carries that Id).
function guestCodes(internalId: string | undefined, ...channel: (string | undefined)[]): string[] {
  const codes = codesFrom(...channel).filter((c) => c !== normalizeCode(internalId ?? ""));
  return codes.length ? codes : codesFrom(internalId);
}

export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9-]/g, "");

const pad = (n: number) => String(n).padStart(2, "0");

// Returns [a, b, year] for slash/dash dates that are not ISO.
function splitDate(v: string): [number, number, number] | null {
  const m = v.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (!m) return null;
  const y = Number(m[3]);
  return [Number(m[1]), Number(m[2]), y < 100 ? 2000 + y : y];
}

function toIsoDate(v: unknown, dayFirst: boolean): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : null;
  }
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${pad(+iso[2])}-${pad(+iso[3])}`;
  const p = splitDate(s);
  if (p) {
    const [a, b, y] = p;
    const [m, d] = dayFirst ? [b, a] : [a, b];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${y}-${pad(m)}-${pad(d)}`;
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

const nightsBetween = (a: string, b: string) =>
  Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));

const num = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return isFinite(n) ? n : 0;
};

/** Parses CSV / XLS / XLSX exports. Rows sharing a reservation Id (one per line item) are merged. */
export function parseSpreadsheet(bytes: Uint8Array, isCsv: boolean): ParsedReservation[] {
  const wb = isCsv
    ? XLSX.read(new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, ""), { type: "string", raw: true })
    : XLSX.read(bytes, { type: "array", cellDates: true });

  const out: ParsedReservation[] = [];
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: "", raw: true });
    // The header row is the first row that names both a guest and an arrival column.
    const headerIdx = grid.findIndex((r) => {
      const n = r.map((c) => norm(String(c)));
      return FIELDS.guest.some((a) => n.includes(a)) && FIELDS.arrival.some((a) => n.includes(a));
    });
    if (headerIdx < 0) continue;
    const header = grid[headerIdx].map((c) => norm(String(c)));
    const col: Record<string, number> = {};
    for (const [field, aliases] of Object.entries(FIELDS)) {
      const i = aliases.map((a) => header.indexOf(a)).find((i) => i >= 0);
      if (i !== undefined) col[field] = i;
    }
    const rows = grid.slice(headerIdx + 1).filter((r) => r.some((c) => String(c).trim() !== ""));
    const get = (r: unknown[], f: string) => (col[f] === undefined ? "" : r[col[f]]);
    const str = (r: unknown[], f: string) => String(get(r, f) ?? "").trim();

    // Day-first if any slash date in the arrival/departure columns has a first part > 12.
    const dayFirst = rows.some((r) =>
      ["arrival", "departure"].some((f) => {
        const p = typeof get(r, f) === "string" ? splitDate(str(r, f)) : null;
        return p !== null && p[0] > 12;
      }),
    );
    const hasLineItems = header.includes("lineitem");

    const byId = new Map<string, ParsedReservation>();
    for (const r of rows) {
      const guestName = str(r, "guest");
      const arrival = toIsoDate(get(r, "arrival"), dayFirst);
      const departure = toIsoDate(get(r, "departure"), dayFirst);
      if (!guestName || !arrival || !departure) continue;

      const confirmation = str(r, "confirmation");
      const externalId = str(r, "id") || confirmation || `${guestName}|${arrival}|${str(r, "house")}`;
      const amount = col.amount === undefined ? null : num(get(r, "amount"));
      const existing = byId.get(externalId);
      if (existing) {
        if (amount !== null && hasLineItems) existing.total = (num(existing.total) + amount).toFixed(2);
        continue;
      }
      const status = str(r, "status").toLowerCase();
      const house = str(r, "house");
      const adults = num(get(r, "adults"));
      const children = num(get(r, "children"));
      byId.set(externalId, {
        externalId,
        codes: guestCodes(str(r, "id"), confirmation, str(r, "sourceText")),
        source: str(r, "source"),
        status: str(r, "cancelled") || /cancel/.test(status) ? "cancelled" : "booked",
        guestName,
        guestEmail: str(r, "email") || null,
        houseName: house,
        villa: villaFromHouse(house),
        arrival,
        departure,
        nights: num(get(r, "nights")) || nightsBetween(arrival, departure),
        guests: num(get(r, "guests")) || adults + children,
        adults,
        children,
        currency: str(r, "currency") || "USD",
        total: amount === null ? null : amount.toFixed(2),
      });
    }
    out.push(...byId.values());
  }
  return out;
}

const PDF_TOOL = {
  name: "save_reservations",
  description: "Save every reservation found in the document.",
  input_schema: {
    type: "object" as const,
    properties: {
      reservations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Internal reservation Id, if present" },
            confirmation_codes: {
              type: "array",
              items: { type: "string" },
              description: "Every confirmation / booking number for this reservation (channel and internal)",
            },
            source: { type: "string", description: "Channel, e.g. Airbnb, Booking.com, Expedia, Website" },
            status: { type: "string", enum: ["booked", "cancelled"] },
            guest_name: { type: "string" },
            guest_email: { type: "string" },
            house_name: { type: "string", description: "Property / villa / unit name as written" },
            arrival: { type: "string", description: "Check-in date, YYYY-MM-DD" },
            departure: { type: "string", description: "Check-out date, YYYY-MM-DD" },
            guests: { type: "integer" },
            adults: { type: "integer" },
            children: { type: "integer" },
            currency: { type: "string" },
            total: { type: "number", description: "Total amount for the stay, if shown" },
          },
          required: ["guest_name", "arrival", "departure"],
        },
      },
    },
    required: ["reservations"],
  },
};

type PdfRow = {
  id?: string; confirmation_codes?: string[]; source?: string; status?: string; guest_name: string;
  guest_email?: string; house_name?: string; arrival: string; departure: string; guests?: number;
  adults?: number; children?: number; currency?: string; total?: number;
};

/** Extracts reservations from an occupancy/booking PDF with AI Gateway. */
export async function parsePdf(bytes: Uint8Array): Promise<ParsedReservation[]> {
  const anthropic = new Anthropic();
  const msg = await anthropic.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 32000,
    tools: [PDF_TOOL],
    tool_choice: { type: "tool", name: "save_reservations" },
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") } },
          {
            type: "text",
            text:
              "This is an occupancy or reservations report for Canavida Villas & Resort (Uvita, Costa Rica). " +
              "Extract every reservation. Merge line items that belong to the same reservation. " +
              "Dates must be YYYY-MM-DD; when a date like 11/04/2026 is ambiguous, use the format the rest of the document uses. " +
              "Do not invent values that are not in the document.",
          },
        ],
      },
    ],
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  const rows = ((block && "input" in block ? (block.input as { reservations?: PdfRow[] }).reservations : []) ?? []);

  return rows
    .map((r): ParsedReservation | null => {
      const arrival = toIsoDate(r.arrival, false);
      const departure = toIsoDate(r.departure, false);
      if (!r.guest_name || !arrival || !departure) return null;
      const codes = guestCodes(r.id, ...(r.confirmation_codes ?? []));
      const house = r.house_name?.trim() ?? "";
      return {
        externalId: r.id?.trim() || codes[0] || `${r.guest_name}|${arrival}|${house}`,
        codes,
        source: r.source ?? "",
        status: r.status === "cancelled" ? "cancelled" : "booked",
        guestName: r.guest_name.trim(),
        guestEmail: r.guest_email || null,
        houseName: house,
        villa: villaFromHouse(house),
        arrival,
        departure,
        nights: nightsBetween(arrival, departure),
        guests: r.guests ?? (r.adults ?? 0) + (r.children ?? 0),
        adults: r.adults ?? 0,
        children: r.children ?? 0,
        currency: r.currency || "USD",
        total: r.total == null ? null : r.total.toFixed(2),
      };
    })
    .filter((r): r is ParsedReservation => r !== null);
}
