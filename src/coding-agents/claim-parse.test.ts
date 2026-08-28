// src/coding-agents/claim-parse.test.ts
import { describe, it, expect } from "vitest";
import { parseClaimResult } from "./claim-parse.js";

describe("parseClaimResult", () => {
  it("parses a granted claim from the structured JSON block", () => {
    const raw = "granted a.ts, b.ts\n" + JSON.stringify({ claimed: true, report: [{ path: "a.ts", status: "claimed" }] });
    const r = parseClaimResult(raw);
    expect(r.claimed).toBe(true);
    expect(r.conflict).toBe(false);
  });

  it("parses a conflict as NOT claimed", () => {
    const raw = "CONFLICT — NOTHING was claimed (all-or-nothing):\n- CONFLICT a.ts\n" +
      JSON.stringify({ claimed: false, report: [{ path: "a.ts", status: "conflict" }] });
    const r = parseClaimResult(raw);
    expect(r.claimed).toBe(false);
    expect(r.conflict).toBe(true);
  });

  it("fails closed when there is NO structured JSON block (unknown = not claimed)", () => {
    const r = parseClaimResult("some prose that vaguely says ok but no json");
    expect(r.claimed).toBe(false);
    expect(r.conflict).toBe(false);
  });

  it("fails closed on a dokoro error string (does NOT count as a grant)", () => {
    const r = parseClaimResult("file_claim rejected — NOTHING was claimed. Invalid path(s):\n- ../escape");
    expect(r.claimed).toBe(false);
  });

  it("fails closed on empty output", () => {
    const r = parseClaimResult("");
    expect(r.claimed).toBe(false);
    expect(r.conflict).toBe(false);
  });

  it("treats a partial claim (claimed:false with would_acquire+conflict) as not claimed", () => {
    const raw = JSON.stringify({ claimed: false, report: [
      { path: "a.ts", status: "would_acquire" }, { path: "b.ts", status: "conflict" },
    ]});
    const r = parseClaimResult(raw);
    expect(r.claimed).toBe(false);
    expect(r.conflict).toBe(true);
  });
});
