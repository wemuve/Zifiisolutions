import { describe, expect, it } from "vitest";
import { bestEntitlement, decideAccess, normalizeMac, type EntitlementView } from "../src/domain/access.js";
import { looksLikeVoucherCode, normalizeVoucherCode, generateVoucherCode } from "../src/domain/vouchers.js";

const now = new Date("2026-10-04T12:00:00Z");
const hour = 3600_000;

function ent(id: string, opts: Partial<EntitlementView> & { down?: number; devices?: number } = {}): EntitlementView {
  return {
    id,
    startsAt: opts.startsAt ?? new Date(now.getTime() - hour),
    endsAt: opts.endsAt ?? new Date(now.getTime() + hour),
    revokedAt: opts.revokedAt ?? null,
    plan: { downloadKbps: opts.down ?? 10_000, uploadKbps: 2_000, maxDevices: opts.devices ?? 1 },
  };
}

const base = {
  subscriber: { siteId: "site-a", disabled: false },
  siteId: "site-a",
  activeDeviceMacs: [] as string[],
  mac: "AA-BB-CC-DD-EE-01",
  now,
};

describe("decideAccess", () => {
  it("accepts an active plan and times the session to the plan's end", () => {
    const d = decideAccess({ ...base, entitlements: [ent("e1")] });
    expect(d).toEqual({ allowed: true, entitlementId: "e1", sessionTimeoutSeconds: 3600, downloadKbps: 10_000, uploadKbps: 2_000 });
  });

  it("rejects a disabled account before anything else", () => {
    expect(decideAccess({ ...base, subscriber: { siteId: "site-a", disabled: true }, entitlements: [ent("e1")] })).toEqual({
      allowed: false,
      reason: "account_disabled",
    });
  });

  it("rejects a login from another site", () => {
    expect(decideAccess({ ...base, siteId: "site-b", entitlements: [ent("e1")] })).toMatchObject({ reason: "wrong_site" });
  });

  it("ignores expired, future and revoked plans", () => {
    const entitlements = [
      ent("expired", { startsAt: new Date(now.getTime() - 2 * hour), endsAt: now }),
      ent("future", { startsAt: new Date(now.getTime() + hour), endsAt: new Date(now.getTime() + 2 * hour) }),
      ent("revoked", { revokedAt: new Date(now.getTime() - 1000) }),
    ];
    expect(decideAccess({ ...base, entitlements })).toMatchObject({ allowed: false, reason: "no_active_plan" });
  });

  it("enforces the device limit but lets a known device reconnect", () => {
    const entitlements = [ent("e1", { devices: 2 })];
    const two = ["aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02"];
    expect(decideAccess({ ...base, mac: "aa:bb:cc:dd:ee:03", activeDeviceMacs: two, entitlements })).toMatchObject({
      reason: "device_limit",
    });
    expect(decideAccess({ ...base, mac: "AA-BB-CC-DD-EE-02", activeDeviceMacs: two, entitlements })).toMatchObject({
      allowed: true,
    });
    expect(decideAccess({ ...base, mac: "aa:bb:cc:dd:ee:03", activeDeviceMacs: two.slice(0, 1), entitlements })).toMatchObject({
      allowed: true,
    });
  });
});

describe("bestEntitlement", () => {
  it("prefers the fastest plan, then the longest", () => {
    const slowLong = ent("slow", { down: 5_000, endsAt: new Date(now.getTime() + 10 * hour) });
    const fastShort = ent("fast-short", { down: 20_000 });
    const fastLong = ent("fast-long", { down: 20_000, endsAt: new Date(now.getTime() + 5 * hour) });
    expect(bestEntitlement([slowLong, fastShort, fastLong], now)?.id).toBe("fast-long");
  });
});

describe("helpers", () => {
  it("normalizes MAC address formats", () => {
    expect(normalizeMac("AA-BB-CC-DD-EE-FF")).toBe("aa:bb:cc:dd:ee:ff");
    expect(normalizeMac("aabb.ccdd.eeff")).toBe("aa:bb:cc:dd:ee:ff");
    expect(normalizeMac(null)).toBeNull();
  });

  it("generates voucher codes that survive retyping", () => {
    const code = generateVoucherCode();
    expect(looksLikeVoucherCode(code)).toBe(true);
    const typed = `${code.slice(0, 5).toLowerCase()} - ${code.slice(5)}`;
    expect(normalizeVoucherCode(typed)).toBe(code);
    expect(looksLikeVoucherCode("alice")).toBe(false);
  });
});
