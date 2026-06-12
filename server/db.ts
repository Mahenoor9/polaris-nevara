import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

const useDatabase = process.env.USE_DATABASE === "true";
const databaseUrl = process.env.DATABASE_URL?.trim() || "";
const databaseClientMode = process.env.DB_CLIENT_MODE?.trim() || "node-postgres";
const databaseEnabled = useDatabase && databaseUrl.length > 0;

let poolInstance: Pool | null = null;
let dbInstance: ReturnType<typeof drizzle> | null = null;

function isSslRequired(url: string): boolean {
  return /sslmode=require/i.test(url);
}

function createPool(): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    max: 20,
    ssl: isSslRequired(databaseUrl) ? { rejectUnauthorized: false } : undefined,
  });

  pool.on("error", (error) => {
    console.error("[DB] pg pool error", {
      message: error.message,
      code: (error as NodeJS.ErrnoException).code,
    });
  });

  return pool;
}

function ensureDatabaseReady(): void {
  if (!databaseEnabled) {
    throw new Error(
      "Database mode is disabled. Set USE_DATABASE=true and provide DATABASE_URL to enable PostgreSQL storage.",
    );
  }
}

export function isDatabaseModeEnabled(): boolean {
  return databaseEnabled;
}

export function getDatabaseModeSummary() {
  return {
    useDatabase,
    hasDatabaseUrl: databaseUrl.length > 0,
    databaseEnabled,
    clientMode: databaseClientMode,
  };
}

export function getPool(): Pool {
  ensureDatabaseReady();

  if (!poolInstance) {
    console.log("[DB] Initializing node-postgres pool", getDatabaseModeSummary());
    poolInstance = createPool();
  }

  return poolInstance;
}

export function getDb() {
  ensureDatabaseReady();

  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema });
  }

  return dbInstance;
}

// Safe db accessor — callers MUST check isDatabaseModeEnabled() before using.
// Pattern:
//   if (!isDatabaseModeEnabled()) return fallback;
//   const { db } = await import("../db");
//   await db.execute(...)
export function getDbOrNull(): ReturnType<typeof drizzle> | null {
  if (!databaseEnabled) return null;
  return getDb();
}

// Backward-compat named export for existing call sites that do:
//   const { db } = await import("../db");
// These call sites MUST be guarded with isDatabaseModeEnabled() before reaching this.
export const db: ReturnType<typeof drizzle> = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, property, receiver) {
    ensureDatabaseReady();
    const resolvedDb = getDb();
    return Reflect.get(resolvedDb as object, property, receiver);
  },
});
