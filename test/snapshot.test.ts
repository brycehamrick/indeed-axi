import { describe, expect, it } from "vitest";
import {
  clipLines,
  DEFAULT_LINE_LIMIT,
  filterLines,
  isValidKey,
  parseTarget,
  SNAPSHOT_SOURCE,
} from "../src/browser/snapshot.js";

describe("parseTarget", () => {
  it("maps refs to data-ia-ref selectors", () => {
    expect(parseTarget("e12")).toEqual({ kind: "ref", selector: '[data-ia-ref="e12"]' });
    expect(parseTarget(" e3 ")).toEqual({ kind: "ref", selector: '[data-ia-ref="e3"]' });
  });

  it("treats anything else as a selector escape hatch", () => {
    expect(parseTarget("text=Sign in")).toEqual({ kind: "selector", selector: "text=Sign in" });
    expect(parseTarget("#submit")).toEqual({ kind: "selector", selector: "#submit" });
    // not a ref: missing e prefix
    expect(parseTarget("12")).toEqual({ kind: "selector", selector: "12" });
  });
});

describe("clipLines", () => {
  it("returns everything under the limit", () => {
    const lines = ["a", "b", "c"];
    expect(clipLines(lines, DEFAULT_LINE_LIMIT)).toEqual({
      shown: lines,
      truncated: false,
      total: 3,
    });
  });

  it("clips with an aggregate count", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    const clipped = clipLines(lines, 4);
    expect(clipped.truncated).toBe(true);
    expect(clipped.total).toBe(10);
    expect(clipped.shown).toEqual(lines.slice(0, 4));
  });
});

describe("filterLines", () => {
  const lines = [
    "- heading \"Candidates\"",
    "- link \"Jane Doe\" [ref=e1]",
    "  - text \"Applied yesterday\"",
    "- link \"John Smith\" [ref=e2]",
    "  - text \"Applied 3 days ago\"",
    "- button \"Reject\" [ref=e3]",
  ];

  it("requires every term to appear (case-insensitive)", () => {
    const result = filterLines(lines, ["jane"]);
    expect(result.matches).toBe(1);
    expect(result.lines.some((line) => line.includes("e1"))).toBe(true);
    // context pulls in the surrounding outline lines
    expect(result.lines.some((line) => line.includes("heading"))).toBe(true);
    // far-away lines stay out of the context window
    expect(result.lines.some((line) => line.includes("Reject"))).toBe(false);
  });

  it("multi-term terms are ANDed", () => {
    const result = filterLines(lines, ["link doe"]);
    expect(result.matches).toBe(1);
  });

  it("reports definitive zero matches", () => {
    const result = filterLines(lines, ["nonexistent"]);
    expect(result.matches).toBe(0);
    expect(result.lines).toEqual([]);
  });

  it("returns all lines for empty terms", () => {
    const result = filterLines(lines, []);
    expect(result.matches).toBe(lines.length);
  });
});

describe("isValidKey", () => {
  it("accepts plain keys and combos", () => {
    expect(isValidKey("Enter")).toBe(true);
    expect(isValidKey("a")).toBe(true);
    expect(isValidKey("Control+A")).toBe(true);
    expect(isValidKey("ArrowDown")).toBe(true);
  });

  it("rejects junk", () => {
    expect(isValidKey("")).toBe(false);
    expect(isValidKey("not a key!")).toBe(false);
  });
});

describe("SNAPSHOT_SOURCE", () => {
  it("is a self-contained expression that resets refs", () => {
    expect(SNAPSHOT_SOURCE.startsWith("(() => {")).toBe(true);
    expect(SNAPSHOT_SOURCE).toContain("data-ia-ref");
    expect(SNAPSHOT_SOURCE).toContain("removeAttribute");
    expect(SNAPSHOT_SOURCE).toContain("location.href");
  });

  it("does not reference module scope", () => {
    // it must not accidentally import or close over anything
    expect(SNAPSHOT_SOURCE).not.toMatch(/^import/m);
    expect(SNAPSHOT_SOURCE).not.toContain("require(");
  });
});
