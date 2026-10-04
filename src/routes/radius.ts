import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { AppContext } from "../app.js";
import { withTransaction } from "../db.js";
import { decideAccess, normalizeMac, REJECT_MESSAGES } from "../domain/access.js";
import { hashPassword, verifyPassword } from "../domain/passwords.js";
import { looksLikeVoucherCode, normalizeVoucherCode } from "../domain/vouchers.js";
import { acceptReply, octets, parseRadiusBody } from "../radius/attributes.js";
import {
  activeDeviceMacs,
  createEntitlement,
  entitlementsFor,
  planById,
  siteByNas,
  subscriberById,
  subscriberByUsername,
  type Site,
  type Subscriber,
  type Voucher,
} from "../store.js";

// Endpoints called by FreeRADIUS through rlm_rest. A 200 accepts the login with the reply
// attributes in the body; a 401 rejects it. See deploy/freeradius for the module config.

function reject(message: string) {
  return { "reply:Reply-Message": message };
}

// A voucher's first login creates the guest account and starts the plan's clock.
async function redeemVoucher(client: PoolClient, code: string, site: Site, now: Date): Promise<Subscriber | null> {
  const { rows } = await client.query<Voucher>("select * from vouchers where code = $1 for update", [code]);
  const voucher = rows[0];
  if (!voucher || voucher.site_id !== site.id) return null;
  if (voucher.redeemed_at) {
    return voucher.subscriber_id ? subscriberById(client, voucher.subscriber_id) : null;
  }
  if (voucher.expires_at && voucher.expires_at <= now) return null;
  const plan = await planById(client, voucher.plan_id);
  if (!plan) return null;

  const created = await client.query<Subscriber>(
    `insert into subscribers (site_id, kind, username, password_hash)
     values ($1, 'guest', $2, $3) returning *`,
    [site.id, code, await hashPassword(code)],
  );
  const subscriber = created.rows[0]!;
  await createEntitlement(client, {
    subscriberId: subscriber.id,
    planId: plan.id,
    startsAt: now,
    durationSeconds: plan.duration_seconds,
    source: "voucher",
  });
  await client.query("update vouchers set redeemed_at = $2, subscriber_id = $3 where code = $1", [
    code,
    now,
    subscriber.id,
  ]);
  return subscriber;
}

// The captive portal sends a voucher code as both username and password.
async function findSubscriber(
  ctx: AppContext,
  username: string,
  password: string,
  site: Site,
): Promise<Subscriber | null> {
  const direct = await subscriberByUsername(ctx.db, username);
  if (direct) return direct;
  if (!looksLikeVoucherCode(username)) return null;
  const code = normalizeVoucherCode(username);
  const existing = await subscriberByUsername(ctx.db, code);
  if (existing) return existing;
  if (normalizeVoucherCode(password) !== code) return null;
  return withTransaction(ctx.db, (client) => redeemVoucher(client, code, site, ctx.now()));
}

export function registerRadiusRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post("/authorize", async (req, reply) => {
    const attrs = parseRadiusBody(req.body);
    const username = attrs["User-Name"] ?? "";
    const password = attrs["User-Password"] ?? "";
    const site = await siteByNas(ctx.db, attrs["NAS-Identifier"] ?? "");
    if (!site) {
      req.log.warn({ nas: attrs["NAS-Identifier"] }, "login from unknown NAS");
      return reply.code(401).send(reject("This location is not set up yet."));
    }

    const subscriber = username && password ? await findSubscriber(ctx, username, password, site) : null;
    const checked = subscriber?.kind === "guest" ? normalizeVoucherCode(password) : password;
    if (!subscriber || !(await verifyPassword(checked, subscriber.password_hash))) {
      return reply.code(401).send(reject("Wrong username, password or voucher code."));
    }

    const now = ctx.now();
    const freshSince = new Date(now.getTime() - ctx.staleSessionMinutes * 60_000);
    const decision = decideAccess({
      subscriber: { siteId: subscriber.site_id, disabled: subscriber.disabled },
      siteId: site.id,
      entitlements: await entitlementsFor(ctx.db, subscriber.id),
      activeDeviceMacs: await activeDeviceMacs(ctx.db, subscriber.id, freshSince),
      mac: attrs["Calling-Station-Id"] ?? null,
      now,
    });
    if (!decision.allowed) {
      return reply.code(401).send(reject(REJECT_MESSAGES[decision.reason]));
    }
    return reply.code(200).send(acceptReply(decision));
  });

  app.post("/accounting", async (req, reply) => {
    const attrs = parseRadiusBody(req.body);
    const status = attrs["Acct-Status-Type"];
    const nas = attrs["NAS-Identifier"] ?? "";
    const now = ctx.now();

    // A router that restarts loses its sessions without sending Stop for each one.
    if (status === "Accounting-On" || status === "Accounting-Off") {
      await ctx.db.query(
        `update radius_sessions set stopped_at = $2, terminate_cause = 'NAS-Reboot'
          where nas_identifier = $1 and stopped_at is null`,
        [nas, now],
      );
      return reply.code(204).send();
    }
    if (status !== "Start" && status !== "Interim-Update" && status !== "Stop") {
      return reply.code(204).send();
    }

    const sessionId = attrs["Acct-Session-Id"];
    const username = attrs["User-Name"] ?? "";
    if (!sessionId || !username) return reply.code(400).send({ error: "Acct-Session-Id and User-Name are required" });

    const site = await siteByNas(ctx.db, nas);
    const subscriber =
      (await subscriberByUsername(ctx.db, username)) ??
      (looksLikeVoucherCode(username) ? await subscriberByUsername(ctx.db, normalizeVoucherCode(username)) : null);
    const sessionTime = Number(attrs["Acct-Session-Time"] ?? 0);
    const startedAt = new Date(now.getTime() - sessionTime * 1000);
    const stoppedAt = status === "Stop" ? now : null;

    await ctx.db.query(
      `insert into radius_sessions
         (nas_identifier, acct_session_id, site_id, subscriber_id, username, calling_station_id,
          framed_ip, nas_ip, started_at, updated_at, stopped_at, input_octets, output_octets, terminate_cause)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (nas_identifier, acct_session_id) do update set
         updated_at = excluded.updated_at,
         framed_ip = coalesce(excluded.framed_ip, radius_sessions.framed_ip),
         stopped_at = coalesce(radius_sessions.stopped_at, excluded.stopped_at),
         input_octets = greatest(radius_sessions.input_octets, excluded.input_octets),
         output_octets = greatest(radius_sessions.output_octets, excluded.output_octets),
         terminate_cause = coalesce(excluded.terminate_cause, radius_sessions.terminate_cause)`,
      [
        nas,
        sessionId,
        site?.id ?? null,
        subscriber?.id ?? null,
        username,
        normalizeMac(attrs["Calling-Station-Id"]),
        attrs["Framed-IP-Address"] ?? null,
        attrs["NAS-IP-Address"] ?? null,
        startedAt,
        now,
        stoppedAt,
        octets(attrs, "Input"),
        octets(attrs, "Output"),
        attrs["Acct-Terminate-Cause"] ?? null,
      ],
    );
    return reply.code(204).send();
  });
}
