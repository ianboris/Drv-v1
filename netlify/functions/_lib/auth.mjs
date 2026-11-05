import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "ddpe_session";
const SESSION_SECONDS = 12 * 60 * 60;

function secret(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required server environment variable: ${name}`);
  return value;
}

function sign(value) {
  return createHmac("sha256", secret("DDPE_SESSION_SECRET")).update(value).digest("base64url");
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

export function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function createSessionCookie() {
  const payload = Buffer.from(JSON.stringify({
    sub: "ddpe-owner",
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  })).toString("base64url");
  const value = `${payload}.${sign(payload)}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function getOwner(request) {
  const cookie = request.headers.get("cookie") || "";
  const token = cookie.split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  try {
    const expected = sign(payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (decoded.sub !== "ddpe-owner" || !Number.isInteger(decoded.exp) || decoded.exp <= Math.floor(Date.now() / 1000)) return null;
    return decoded.sub;
  } catch {
    return null;
  }
}

export function requireOwner(request) {
  return getOwner(request) === "ddpe-owner";
}

export function verifyLoginPassword(candidate) {
  const configured = secret("DDPE_APP_PASSWORD");
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function db() {
  const connectionString = secret("DATABASE_URL");
  return import("@neondatabase/serverless").then(({ neon }) => neon(connectionString));
}

export function hasEnv(name) {
  return Boolean(process.env[name]);
}
