import test from "node:test";
import assert from "node:assert/strict";
import api from "../netlify/functions/api.mjs";

test("health endpoint fails closed when Neon credentials are absent", async () => {
  const old = {
    DATABASE_URL: process.env.DATABASE_URL,
    DDPE_LOGIN_PASSWORD: process.env.DDPE_LOGIN_PASSWORD,
    DDPE_SESSION_SECRET: process.env.DDPE_SESSION_SECRET,
  };
  delete process.env.DATABASE_URL;
  delete process.env.DDPE_LOGIN_PASSWORD;
  delete process.env.DDPE_SESSION_SECRET;
  try {
    const response = await api(new Request("https://example.test/api/health"));
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.checks.database_configured, false);
    assert.equal(body.checks.database_connected, false);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("protected settings endpoint rejects missing session", async () => {
  const old = process.env.DDPE_SESSION_SECRET;
  delete process.env.DDPE_SESSION_SECRET;
  try {
    const response = await api(new Request("https://example.test/api/settings"));
    assert.equal(response.status, 503);
  } finally {
    if (old === undefined) delete process.env.DDPE_SESSION_SECRET;
    else process.env.DDPE_SESSION_SECRET = old;
  }
});

test("login endpoint fails closed when app credentials are absent", async () => {
  const oldPassword = process.env.DDPE_LOGIN_PASSWORD;
  const oldSecret = process.env.DDPE_SESSION_SECRET;
  delete process.env.DDPE_LOGIN_PASSWORD;
  delete process.env.DDPE_SESSION_SECRET;
  try {
    const response = await api(new Request("https://example.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.test" },
      body: JSON.stringify({ password: "test" }),
    }));
    assert.equal(response.status, 503);
  } finally {
    if (oldPassword === undefined) delete process.env.DDPE_LOGIN_PASSWORD;
    else process.env.DDPE_LOGIN_PASSWORD = oldPassword;
    if (oldSecret === undefined) delete process.env.DDPE_SESSION_SECRET;
    else process.env.DDPE_SESSION_SECRET = oldSecret;
  }
});
