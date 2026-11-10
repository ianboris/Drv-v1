import test from "node:test";
import assert from "node:assert/strict";
import { digitFromQuote, normalizePipSize } from "../src/market-data.mjs";

test("normalizes integer decimal-place precision from older responses", () => {
  assert.equal(normalizePipSize(2), 2);
  assert.equal(normalizePipSize(0), 0);
});

test("normalizes fractional Deriv price increments to decimal places", () => {
  assert.equal(normalizePipSize(0.1), 1);
  assert.equal(normalizePipSize(0.01), 2);
  assert.equal(normalizePipSize(0.001), 3);
  assert.equal(normalizePipSize(0.25), 2);
});

test("uses quote precision only when pip metadata is unavailable", () => {
  assert.equal(normalizePipSize(undefined, 123.456), 3);
  assert.equal(normalizePipSize(null, 123.4), 1);
  assert.equal(normalizePipSize(undefined), undefined);
});

test("calculates final digits using normalized precision", () => {
  assert.equal(digitFromQuote(123.45, 0.01), 5);
  assert.equal(digitFromQuote(123.4, 0.01), 0);
  assert.equal(digitFromQuote(987.6, 1), 6);
  assert.equal(digitFromQuote(42, 0), 2);
});
