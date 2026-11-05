import { clearSessionCookie, createSessionCookie, json, requireOwner, requireSameOrigin, verifyLoginPassword } from "./_lib/auth.mjs";

export const config = { path: "/api/auth" };

export default async function handler(request) {
  if (request.method === "GET") {
    return json({ authenticated: requireOwner(request) });
  }

  if (!requireSameOrigin(request)) return json({ error: "Invalid request origin." }, 403);

  if (request.method === "DELETE") {
    return json({ authenticated: false }, 200, { "set-cookie": clearSessionCookie() });
  }

  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "GET, POST, DELETE" });

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  try {
    if (!verifyLoginPassword(body?.password)) return json({ error: "Invalid credentials." }, 401);
    return json({ authenticated: true }, 200, { "set-cookie": createSessionCookie() });
  } catch (error) {
    return json({ error: "Authentication is not configured on the server." }, 503);
  }
}
