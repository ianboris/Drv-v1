import { db, hasEnv, json } from "./_lib/auth.mjs";

export const config = { path: "/api/health" };

export default async function handler(request) {
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { allow: "GET" });
  const checks = {
    databaseConfigured: hasEnv("DATABASE_URL"),
    appPasswordConfigured: hasEnv("DDPE_APP_PASSWORD"),
    sessionSecretConfigured: hasEnv("DDPE_SESSION_SECRET"),
    derivTokenConfigured: hasEnv("DERIV_PAT"),
    derivAppIdConfigured: hasEnv("DERIV_APP_ID")
  };
  if (checks.databaseConfigured) {
    try {
      const sql = await db();
      await sql`SELECT 1 AS ok`;
      checks.databaseReachable = true;
    } catch {
      checks.databaseReachable = false;
    }
  } else {
    checks.databaseReachable = false;
  }
  const ready = checks.databaseReachable && checks.appPasswordConfigured && checks.sessionSecretConfigured;
  return json({ status: ready ? "ready-for-authenticated-data" : "configuration-incomplete", checks, liveExecution: false });
}
