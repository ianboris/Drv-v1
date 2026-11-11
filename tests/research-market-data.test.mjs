import test from "node:test";
import assert from "node:assert/strict";
import { digitFromQuote, normalizePipSize } from "../src/market-data.mjs";

test("normalizes Deriv decimal precision and tick increments", () => {
  assert.equal(normalizePipSize(3), 3);
  assert.equal(normalizePipSize(0.01), 2);
  assert.equal(normalizePipSize(undefined, 123.45), 2);
});

test("extracts the final displayed decimal digit", () => {
  assert.equal(digitFromQuote(123.45, 2), 5);
  assert.equal(digitFromQuote(1.2, 3), 0);
  assert.equal(digitFromQuote(987.654, 3), 4);
});

test("keeps digit output in the valid range", () => {
  for (let digit = 0; digit <= 9; digit++) {
    assert.ok(digitFromQuote(digit / 10, 2) >= 0);
    assert.ok(digitFromQuote(digit / 10, 2) <= 9);
  }
});
