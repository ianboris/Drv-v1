import { db, json, requireOwner, requireSameOrigin } from "../lib/auth.mjs";

export const config = { path: "/api/settings" };
const OWNER_ID = "ddpe-owner";

export default async function handler(request) {
  if (!requireOwner(request)) return json({ error: "Authentication required." }, 401);
  if (request.method === "GET") {
    try {
      const sql = await db();
      const rows = await sql`SELECT stake, daily_loss_limit, analysis_window, updated_at FROM ddpe_settings WHERE owner_id = ${OWNER_ID} LIMIT 1`;
      if (!rows.length) return json({ stake: 1, dailyLossLimit: 2, windowSize: 100, source: "defaults-not-yet-saved" });
      return json({
        stake: Number(rows[0].stake),
        dailyLossLimit: Number(rows[0].daily_loss_limit),
        windowSize: Number(rows[0].analysis_window),
        updatedAt: rows[0].updated_at
      });
    } catch {
      return json({ error: "Could not read settings. Confirm the Neon migration has been applied." }, 503);
    }
  }

  if (request.method !== "PUT") return json({ error: "Method not allowed." }, 405, { allow: "GET, PUT" });
  if (!requireSameOrigin(request)) return json({ error: "Invalid request origin." }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const stake = Number(body?.stake);
  const dailyLossLimit = Number(body?.dailyLossLimit);
  const windowSize = Number(body?.windowSize);
  if (!Number.isFinite(stake) || stake < 0.01 || stake > 1000 ||
      !Number.isFinite(dailyLossLimit) || dailyLossLimit < 0.01 || dailyLossLimit > 10000 ||
      !Number.isInteger(windowSize) || windowSize < 50 || windowSize > 5000) {
    return json({ error: "Settings outside permitted server limits." }, 422);
  }

  try {
    const sql = await db();
    const rows = await sql`
      INSERT INTO ddpe_settings (owner_id, stake, daily_loss_limit, analysis_window, updated_at)
      VALUES (${OWNER_ID}, ${stake}, ${dailyLossLimit}, ${windowSize}, NOW())
      ON CONFLICT (owner_id) DO UPDATE SET
        stake = EXCLUDED.stake,
        daily_loss_limit = EXCLUDED.daily_loss_limit,
        analysis_window = EXCLUDED.analysis_window,
        updated_at = NOW()
      RETURNING stake, daily_loss_limit, analysis_window, updated_at
    `;
    return json({
      stake: Number(rows[0].stake),
      dailyLossLimit: Number(rows[0].daily_loss_limit),
      windowSize: Number(rows[0].analysis_window),
      updatedAt: rows[0].updated_at
    });
  } catch {
    return json({ error: "Could not save settings. Confirm the Neon migration has been applied." }, 503);
  }
}
