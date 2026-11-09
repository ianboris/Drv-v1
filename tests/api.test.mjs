import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import api from "../server/api-handler.mjs";

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

function signedSession(secret) {
  const payload = Buffer.from(JSON.stringify({
    sub: "primary",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: "test-session-nonce",
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

test("tick API rejects rows without stable tick identity before database access", async () => {
  const secret = "s".repeat(40);
  const old = process.env.DDPE_SESSION_SECRET;
  process.env.DDPE_SESSION_SECRET = secret;
  try {
    const response = await api(new Request("https://example.test/api/ticks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.test",
        cookie: `ddpe_session=${signedSession(secret)}`,
      },
      body: JSON.stringify({ ticks: [{
        symbol: "1HZ100V",
        epoch: 1,
        quote: 123.45,
        pip_size: 2,
        last_digit: 5,
      }] }),
    }));
    assert.equal(response.status, 400);
  } finally {
    if (old === undefined) delete process.env.DDPE_SESSION_SECRET;
    else process.env.DDPE_SESSION_SECRET = old;
  }
});

test("choice API rejects settlement at the prediction second before database access", async () => {
  const secret = "s".repeat(40);
  const old = process.env.DDPE_SESSION_SECRET;
  process.env.DDPE_SESSION_SECRET = secret;
  try {
    const response = await api(new Request("https://example.test/api/choices", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.test",
        cookie: "ddpe_session=" + signedSession(secret),
      },
      body: JSON.stringify({ choices: [{
        choice_uid: "choice-same-second-123",
        symbol: "1HZ100V",
        barrier_digit: 3,
        predicted_at_epoch: 100,
        settled_at_epoch: 100,
        outcome_digit: 4,
        is_correct: true,
        analysis_window: 100,
      }] }),
    }));
    assert.equal(response.status, 400);
  } finally {
    if (old === undefined) delete process.env.DDPE_SESSION_SECRET;
    else process.env.DDPE_SESSION_SECRET = old;
  }
});

test("choice API rejects same-second-invalid fields before database access", async () => {
  const secret = "s".repeat(40);
  const old = process.env.DDPE_SESSION_SECRET;
  process.env.DDPE_SESSION_SECRET = secret;
  try {
    const response = await api(new Request("https://example.test/api/choices", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.test",
        cookie: `ddpe_session=${signedSession(secret)}`,
      },
      body: JSON.stringify({ choices: [{
        choice_uid: "choice-12345678",
        symbol: "1HZ100V",
        barrier_digit: 3,
        predicted_at_epoch: 100,
        settled_at_epoch: 99,
        outcome_digit: 4,
        is_correct: true,
        analysis_window: 100,
      }] }),
    }));
    assert.equal(response.status, 400);
  } finally {
    if (old === undefined) delete process.env.DDPE_SESSION_SECRET;
    else process.env.DDPE_SESSION_SECRET = old;
  }
});
