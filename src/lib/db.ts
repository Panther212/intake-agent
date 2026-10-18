import "server-only";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (add it to .env.local)");
}

// Tagged-template client: sql`select * from sessions where id = ${id}` is parameterised.
export const sql = neon(process.env.DATABASE_URL);
