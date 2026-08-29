import assert from "node:assert/strict";
import test from "node:test";

import { sum } from "../src/sum.js";

test("sums positive numbers", () => {
  assert.equal(sum([1, 2, 3, 4]), 10);
});

test("sums negative numbers", () => {
  assert.equal(sum([-1, -2, -3]), -6);
});

test("sums a mix of signs", () => {
  assert.equal(sum([5, -3, 2]), 4);
});

test("returns 0 for an empty array", () => {
  assert.equal(sum([]), 0);
});
