import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { withTransaction } from "../db.js";
import { bestEntitlement } from "../domain/access.js";
import { hashPassword } from "../domain/passwords.js";
import { generateVoucherCode, looksLikeVoucherCode } from "../domain/vouchers.js";
import { createEntitlement, entitlementsFor, planById, siteById, subscriberById } from "../store.js";

// Staff API for setting up sites and plans, registering residents and printing guest vouchers.

const uuid = z.uuid();

const siteInput = z.object({
  name: z.string().min(1),
  nasIdentifier: z.string().min(1),
  countryCode: z.string().length(2).default("ZM"),
});

const planInput = z.object({
  code: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  durationSeconds: z.number().int().positive(),
  downloadKbps: z.number().int().positive(),
  uploadKbps: z.number().int().positive(),
  maxDevices: z.number().int().positive().default(1),
  priceMinor: z.number().int().nonnegative().nullable().default(null),
  countryCode: z.string().length(2).default("ZM"),
});

const subscriberInput = z.object({
  siteId: uuid,
  // Voucher-shaped usernames are kept for guests so a code can never collide with a resident.
  username: z
    .string()
    .min(3)
    .max(64)
    .refine((u) => !looksLikeVoucherCode(u), "username must not look like a voucher code"),
  password: z.string().min(8),
  displayName: z.string().optional(),
  phone: z.string().optional(),
});

const entitlementInput = z.object({
  planId: uuid,
  startsAt: z.coerce.date().optional(),
});

const voucherInput = z.object({
  siteId: uuid,
  planId: uuid,
  count: z.number().int().min(1).max(500),
  batch: z.string().min(1).optional(),
  expiresAt: z.coerce.date().optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(body);
  if (!result.success) {
    void reply.code(400).send({ error: "invalid_request", issues: result.error.issues });
    return undefined;
  }
  return result.data;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.get("/sites", async () => (await db.query("select * from sites order by name")).rows);

  app.post("/sites", async (req, reply) => {
    const input = parse(siteInput, req.body, reply);
    if (!input) return;
    try {
      const { rows } = await db.query(
        "insert into sites (name, nas_identifier, country_code) values ($1, $2, $3) returning *",
        [input.name, input.nasIdentifier, input.countryCode],
      );
      return reply.code(201).send(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "nas_identifier_taken" });
      throw err;
    }
  });

  app.get("/plans", async () => (await db.query("select * from plans order by country_code, code")).rows);

  app.post("/plans", async (req, reply) => {
    const input = parse(planInput, req.body, reply);
    if (!input) return;
    try {
      const { rows } = await db.query(
        `insert into plans (code, name, duration_seconds, download_kbps, upload_kbps, max_devices, price_minor, country_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [
          input.code,
          input.name,
          input.durationSeconds,
          input.downloadKbps,
          input.uploadKbps,
          input.maxDevices,
          input.priceMinor,
          input.countryCode,
        ],
      );
      return reply.code(201).send(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "plan_code_taken" });
      throw err;
    }
  });

  app.post("/subscribers", async (req, reply) => {
    const input = parse(subscriberInput, req.body, reply);
    if (!input) return;
    if (!(await siteById(db, input.siteId))) return reply.code(404).send({ error: "site_not_found" });
    try {
      const { rows } = await db.query(
        `insert into subscribers (site_id, kind, username, password_hash, display_name, phone)
         values ($1, 'resident', $2, $3, $4, $5)
         returning id, site_id, kind, username, display_name, phone, disabled, created_at`,
        [input.siteId, input.username, await hashPassword(input.password), input.displayName ?? null, input.phone ?? null],
      );
      return reply.code(201).send(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "username_taken" });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/subscribers/:id", async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "subscriber_not_found" });
    const subscriber = await subscriberById(db, req.params.id);
    if (!subscriber) return reply.code(404).send({ error: "subscriber_not_found" });
    const entitlements = await entitlementsFor(db, subscriber.id);
    const { password_hash: _hidden, ...visible } = subscriber;
    return {
      ...visible,
      activeEntitlementId: bestEntitlement(entitlements, ctx.now())?.id ?? null,
      entitlements,
    };
  });

  app.patch<{ Params: { id: string } }>("/subscribers/:id", async (req, reply) => {
    const input = parse(z.object({ disabled: z.boolean() }), req.body, reply);
    if (!input) return;
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "subscriber_not_found" });
    const { rowCount } = await db.query("update subscribers set disabled = $2 where id = $1", [
      req.params.id,
      input.disabled,
    ]);
    if (!rowCount) return reply.code(404).send({ error: "subscriber_not_found" });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/subscribers/:id/entitlements", async (req, reply) => {
    const input = parse(entitlementInput, req.body, reply);
    if (!input) return;
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "subscriber_not_found" });
    const subscriber = await subscriberById(db, req.params.id);
    if (!subscriber) return reply.code(404).send({ error: "subscriber_not_found" });
    const plan = await planById(db, input.planId);
    if (!plan || !plan.active) return reply.code(404).send({ error: "plan_not_found" });
    const entitlement = await createEntitlement(db, {
      subscriberId: subscriber.id,
      planId: plan.id,
      startsAt: input.startsAt ?? ctx.now(),
      durationSeconds: plan.duration_seconds,
      source: "admin",
    });
    return reply.code(201).send(entitlement);
  });

  app.post<{ Params: { id: string } }>("/entitlements/:id/revoke", async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "entitlement_not_found" });
    const { rowCount } = await db.query(
      "update entitlements set revoked_at = coalesce(revoked_at, $2) where id = $1",
      [req.params.id, ctx.now()],
    );
    if (!rowCount) return reply.code(404).send({ error: "entitlement_not_found" });
    return reply.code(204).send();
  });

  app.post("/vouchers", async (req, reply) => {
    const input = parse(voucherInput, req.body, reply);
    if (!input) return;
    if (!(await siteById(db, input.siteId))) return reply.code(404).send({ error: "site_not_found" });
    const plan = await planById(db, input.planId);
    if (!plan || !plan.active) return reply.code(404).send({ error: "plan_not_found" });
    const batch = input.batch ?? `${plan.code}-${ctx.now().toISOString().slice(0, 10)}`;

    const codes = await withTransaction(db, async (client) => {
      const issued: string[] = [];
      while (issued.length < input.count) {
        const code = generateVoucherCode();
        const { rowCount } = await client.query(
          `insert into vouchers (code, site_id, plan_id, batch, expires_at)
           values ($1, $2, $3, $4, $5) on conflict (code) do nothing`,
          [code, input.siteId, plan.id, batch, input.expiresAt ?? null],
        );
        if (rowCount) issued.push(code);
      }
      return issued;
    });
    return reply.code(201).send({ batch, plan: plan.code, expiresAt: input.expiresAt ?? null, codes });
  });

  // Who is online at a site right now, for support calls and the pilot's peak-user figures.
  app.get<{ Params: { id: string } }>("/sites/:id/sessions", async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "site_not_found" });
    const freshSince = new Date(ctx.now().getTime() - ctx.staleSessionMinutes * 60_000);
    const { rows } = await db.query(
      `select username, calling_station_id, framed_ip, started_at, updated_at, input_octets, output_octets
         from radius_sessions
        where site_id = $1 and stopped_at is null and updated_at >= $2
        order by started_at`,
      [req.params.id, freshSince],
    );
    return rows;
  });
}
