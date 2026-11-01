// Separate file because it replaces node:crypto's timingSafeEqual with a counting wrapper.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: number[] = [];

vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return {
    ...real,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      calls.push(a.byteLength);
      return real.timingSafeEqual(a, b);
    },
  };
});

const { computeSignature, safeEqualStrings, verifySignature } = await import("../src/signature.ts");

beforeEach(() => {
  calls.length = 0;
});

describe("constant-time comparison", () => {
  const body = "{}";
  const secrets = [{ secret: "one" }, { secret: "two" }, { secret: "three" }];

  it("compares with timingSafeEqual against every secret, whichever one matches", () => {
    for (const s of secrets) {
      calls.length = 0;
      const r = verifySignature({ rawBody: body, header: computeSignature(s.secret, body), secrets });
      expect(r.ok).toBe(true);
      expect(calls).toEqual([32, 32, 32]);
    }
  });

  it("does the same amount of work when nothing matches", () => {
    verifySignature({ rawBody: body, header: computeSignature("nope", body), secrets });
    expect(calls).toEqual([32, 32, 32]);
  });

  it("compares equal-length digests of the verify token, so lengths do not leak", () => {
    safeEqualStrings("short", "a much longer verify token than the other one");
    expect(calls).toEqual([32]);
  });
});
