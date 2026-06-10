import { describe, it, expect } from "vitest";
import { num, gcInterval } from "../config.js";

describe("num", () => {
  it("parses positive numbers", () => expect(num("250", 5)).toBe(250));
  it("falls back on unset / NaN / zero / negative", () => {
    expect(num(undefined, 5)).toBe(5);
    expect(num("abc", 5)).toBe(5);
    expect(num("0", 5)).toBe(5);
    expect(num("-3", 5)).toBe(5);
  });
});

describe("gcInterval", () => {
  it("clamps to [1s, 60s]", () => {
    expect(gcInterval(500)).toBe(1_000);       // floor 1s
    expect(gcInterval(30_000)).toBe(30_000);   // pass-through inside range
    expect(gcInterval(600_000)).toBe(60_000);  // ceiling 60s
  });
});
