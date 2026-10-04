import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db.js";
import { ADMIN, RADIUS, freshDb, rlmRest, testApp } from "./helpers.js";

const start = new Date("2026-10-04T08:00:00Z");
const clock = { now: start };
let db: Db;
let app: FastifyInstance;
let site: { id: string };
let otherSite: { id: string };
let resident: { id: string };
let plan: { id: string };

async function admin(method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
  return app.inject({ method, url: `/admin${url}`, headers: ADMIN, payload });
}

async function login(username: string, password: string, mac = "aa:bb:cc:00:00:01", nas = "lusaka-pilot-1") {
  return app.inject({
    method: "POST",
    url: "/radius/authorize",
    headers: RADIUS,
    payload: rlmRest({ "User-Name": username, "User-Password": password, "Calling-Station-Id": mac, "NAS-Identifier": nas }),
  });
}

async function account(attrs: Record<string, string | number>) {
  return app.inject({
    method: "POST",
    url: "/radius/accounting",
    headers: RADIUS,
    payload: rlmRest({ "NAS-Identifier": "lusaka-pilot-1", ...attrs }),
  });
}

beforeAll(async () => {
  db = await freshDb();
  app = testApp(db, clock);
});

afterAll(async () => {
  await app.close();
  await db.end();
});

beforeEach(async () => {
  clock.now = start;
  await db.query("truncate radius_sessions, vouchers, entitlements, subscribers, plans, sites cascade");
  site = (await admin("POST", "/sites", { name: "Pilot block A", nasIdentifier: "lusaka-pilot-1" })).json();
  otherSite = (await admin("POST", "/sites", { name: "Rural hub", nasIdentifier: "rural-1" })).json();
  plan = (
    await admin("POST", "/plans", {
      code: "resident-standard",
      name: "Resident Standard",
      durationSeconds: 30 * 86400,
      downloadKbps: 10_000,
      uploadKbps: 3_000,
      maxDevices: 2,
    })
  ).json();
  resident = (
    await admin("POST", "/subscribers", { siteId: site.id, username: "unit12", password: "correct-horse", displayName: "Unit 12" })
  ).json();
});

describe("authentication", () => {
  it("requires the RADIUS token on RADIUS endpoints and the admin token on admin endpoints", async () => {
    const noToken = await app.inject({ method: "POST", url: "/radius/authorize", payload: {} });
    expect(noToken.statusCode).toBe(401);
    const wrongToken = await app.inject({ method: "GET", url: "/admin/sites", headers: RADIUS });
    expect(wrongToken.statusCode).toBe(401);
  });
});

describe("resident logins", () => {
  it("rejects a resident with no plan, then accepts once a plan is issued", async () => {
    const before = await login("unit12", "correct-horse");
    expect(before.statusCode).toBe(401);
    expect(before.json()["reply:Reply-Message"]).toMatch(/no active plan/);

    expect((await admin("POST", `/subscribers/${resident.id}/entitlements`, { planId: plan.id })).statusCode).toBe(201);

    const after = await login("unit12", "correct-horse");
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({
      "reply:Session-Timeout": 30 * 86400,
      "reply:WISPr-Bandwidth-Max-Down": 10_000_000,
      "reply:WISPr-Bandwidth-Max-Up": 3_000_000,
      "reply:Mikrotik-Rate-Limit": "3000k/10000k",
      "reply:Acct-Interim-Interval": 300,
    });
  });

  it("rejects a wrong password, an unknown site and the wrong site", async () => {
    await admin("POST", `/subscribers/${resident.id}/entitlements`, { planId: plan.id });
    expect((await login("unit12", "wrong-password")).statusCode).toBe(401);
    expect((await login("unit12", "correct-horse", undefined, "nobody")).statusCode).toBe(401);
    const wrongSite = await login("unit12", "correct-horse", undefined, "rural-1");
    expect(wrongSite.statusCode).toBe(401);
    expect(wrongSite.json()["reply:Reply-Message"]).toMatch(/not registered at this location/);
  });

  it("stops accepting a login once the plan is revoked or the account disabled", async () => {
    const ent = (await admin("POST", `/subscribers/${resident.id}/entitlements`, { planId: plan.id })).json();
    expect((await login("unit12", "correct-horse")).statusCode).toBe(200);

    await admin("PATCH", `/subscribers/${resident.id}`, { disabled: true });
    expect((await login("unit12", "correct-horse")).json()["reply:Reply-Message"]).toMatch(/disabled/);
    await admin("PATCH", `/subscribers/${resident.id}`, { disabled: false });

    expect((await admin("POST", `/entitlements/${ent.id}/revoke`)).statusCode).toBe(204);
    expect((await login("unit12", "correct-horse")).statusCode).toBe(401);
  });

  it("enforces the device limit from live accounting sessions and frees a slot on Stop", async () => {
    await admin("POST", `/subscribers/${resident.id}/entitlements`, { planId: plan.id });
    for (const [i, mac] of ["aa:bb:cc:00:00:01", "aa:bb:cc:00:00:02"].entries()) {
      expect((await login("unit12", "correct-horse", mac)).statusCode).toBe(200);
      await account({ "Acct-Status-Type": "Start", "Acct-Session-Id": `s${i}`, "User-Name": "unit12", "Calling-Station-Id": mac });
    }

    const third = await login("unit12", "correct-horse", "aa:bb:cc:00:00:03");
    expect(third.statusCode).toBe(401);
    expect(third.json()["reply:Reply-Message"]).toMatch(/device limit/);
    // A device that already has a session may reconnect, written in another MAC format.
    expect((await login("unit12", "correct-horse", "AA-BB-CC-00-00-02")).statusCode).toBe(200);

    await account({ "Acct-Status-Type": "Stop", "Acct-Session-Id": "s0", "User-Name": "unit12", "Acct-Session-Time": 600 });
    expect((await login("unit12", "correct-horse", "aa:bb:cc:00:00:03")).statusCode).toBe(200);
  });

  it("stops counting sessions the router has gone quiet on, and closes all of them on Accounting-On", async () => {
    await admin("POST", `/subscribers/${resident.id}/entitlements`, { planId: plan.id });
    await account({ "Acct-Status-Type": "Start", "Acct-Session-Id": "a", "User-Name": "unit12", "Calling-Station-Id": "aa:bb:cc:00:00:01" });
    await account({ "Acct-Status-Type": "Start", "Acct-Session-Id": "b", "User-Name": "unit12", "Calling-Station-Id": "aa:bb:cc:00:00:02" });
    expect((await login("unit12", "correct-horse", "aa:bb:cc:00:00:03")).statusCode).toBe(401);

    clock.now = new Date(start.getTime() + 16 * 60_000);
    expect((await login("unit12", "correct-horse", "aa:bb:cc:00:00:03")).statusCode).toBe(200);

    await account({ "Acct-Status-Type": "Accounting-On" });
    const open = await db.query("select count(*)::int as n from radius_sessions where stopped_at is null");
    expect(open.rows[0].n).toBe(0);
  });
});

describe("guest vouchers", () => {
  async function dayPassVouchers(count: number, expiresAt?: string) {
    const dayPass = (
      await admin("POST", "/plans", { code: "day-pass", name: "Day pass", durationSeconds: 86400, downloadKbps: 5_000, uploadKbps: 1_000 })
    ).json();
    const res = await admin("POST", "/vouchers", { siteId: site.id, planId: dayPass.id, count, expiresAt });
    expect(res.statusCode).toBe(201);
    return res.json() as { batch: string; codes: string[] };
  }

  it("issues unique codes in a named batch", async () => {
    const { batch, codes } = await dayPassVouchers(25);
    expect(batch).toBe("day-pass-2026-10-04");
    expect(new Set(codes).size).toBe(25);
  });

  it("starts the plan on first login and keeps the same clock on later logins", async () => {
    const [code] = (await dayPassVouchers(1)).codes as [string];
    const first = await login(code.toLowerCase(), code.toLowerCase());
    expect(first.statusCode).toBe(200);
    expect(first.json()["reply:Session-Timeout"]).toBe(86400);

    clock.now = new Date(start.getTime() + 3600_000);
    const later = await login(code, code);
    expect(later.json()["reply:Session-Timeout"]).toBe(86400 - 3600);

    clock.now = new Date(start.getTime() + 86400_000);
    expect((await login(code, code)).json()["reply:Reply-Message"]).toMatch(/no active plan/);
  });

  it("redeems a voucher only once even when two devices log in at the same moment", async () => {
    const [code] = (await dayPassVouchers(1)).codes as [string];
    const results = await Promise.all([login(code, code), login(code, code)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const counts = await db.query("select (select count(*) from subscribers where kind = 'guest')::int as subs, (select count(*) from entitlements)::int as ents");
    expect(counts.rows[0]).toEqual({ subs: 1, ents: 1 });
  });

  it("rejects a wrong code, an expired voucher, a voucher from another site, and does not redeem on a bad password", async () => {
    const [code] = (await dayPassVouchers(1, "2026-10-04T07:00:00Z")).codes as [string];
    expect((await login(code, code)).statusCode).toBe(401);
    expect((await login("ABCDEFGHJK", "ABCDEFGHJK")).statusCode).toBe(401);

    const fresh = await admin("POST", "/vouchers", { siteId: otherSite.id, planId: plan.id, count: 1 });
    const [rural] = fresh.json().codes as [string];
    expect((await login(rural, rural)).statusCode).toBe(401);
    expect((await login(rural, "not-the-code", undefined, "rural-1")).statusCode).toBe(401);
    const redeemed = await db.query("select redeemed_at from vouchers where code = $1", [rural]);
    expect(redeemed.rows[0].redeemed_at).toBeNull();
  });
});

describe("accounting", () => {
  it("records a session from Start to Stop, including gigaword counters", async () => {
    await account({
      "Acct-Status-Type": "Start",
      "Acct-Session-Id": "8100001",
      "User-Name": "unit12",
      "Calling-Station-Id": "AA-BB-CC-00-00-09",
      "Framed-IP-Address": "10.20.0.15",
    });
    const online = await admin("GET", `/sites/${site.id}/sessions`);
    expect(online.json()).toHaveLength(1);

    clock.now = new Date(start.getTime() + 600_000);
    await account({
      "Acct-Status-Type": "Stop",
      "Acct-Session-Id": "8100001",
      "User-Name": "unit12",
      "Acct-Session-Time": 600,
      "Acct-Input-Octets": 5,
      "Acct-Input-Gigawords": 1,
      "Acct-Output-Octets": 1000,
      "Acct-Terminate-Cause": "User-Request",
    });

    const { rows } = await db.query("select * from radius_sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subscriber_id: resident.id,
      site_id: site.id,
      calling_station_id: "aa:bb:cc:00:00:09",
      framed_ip: "10.20.0.15",
      input_octets: String(2 ** 32 + 5),
      output_octets: "1000",
      terminate_cause: "User-Request",
    });
    expect(rows[0].stopped_at).toEqual(clock.now);
    expect((await admin("GET", `/sites/${site.id}/sessions`)).json()).toHaveLength(0);
  });
});

describe("admin validation", () => {
  it("rejects bad input and duplicates", async () => {
    expect((await admin("POST", "/plans", { code: "Bad Code" })).statusCode).toBe(400);
    expect((await admin("POST", "/sites", { name: "Dup", nasIdentifier: "lusaka-pilot-1" })).statusCode).toBe(409);
    expect(
      (await admin("POST", "/subscribers", { siteId: site.id, username: "unit12", password: "another-pass" })).statusCode,
    ).toBe(409);
    expect(
      (await admin("POST", "/subscribers", { siteId: site.id, username: "ABCDEFGHJK", password: "another-pass" })).statusCode,
    ).toBe(400);
  });

  it("never returns password hashes", async () => {
    const res = await admin("GET", `/subscribers/${resident.id}`);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain("scrypt");
  });
});
