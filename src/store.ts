import type { Queryable } from "./db.js";
import type { EntitlementView } from "./domain/access.js";

export interface Site {
  id: string;
  country_code: string;
  name: string;
  nas_identifier: string;
}

export interface Plan {
  id: string;
  country_code: string;
  code: string;
  name: string;
  duration_seconds: number;
  download_kbps: number;
  upload_kbps: number;
  max_devices: number;
  price_minor: string | null;
  active: boolean;
}

export interface Subscriber {
  id: string;
  site_id: string;
  kind: "resident" | "guest";
  username: string;
  password_hash: string;
  display_name: string | null;
  phone: string | null;
  disabled: boolean;
}

export interface Voucher {
  code: string;
  site_id: string;
  plan_id: string;
  batch: string;
  expires_at: Date | null;
  redeemed_at: Date | null;
  subscriber_id: string | null;
}

export async function siteByNas(db: Queryable, nasIdentifier: string): Promise<Site | null> {
  const { rows } = await db.query<Site>("select * from sites where nas_identifier = $1", [nasIdentifier]);
  return rows[0] ?? null;
}

export async function siteById(db: Queryable, id: string): Promise<Site | null> {
  const { rows } = await db.query<Site>("select * from sites where id = $1", [id]);
  return rows[0] ?? null;
}

export async function planById(db: Queryable, id: string): Promise<Plan | null> {
  const { rows } = await db.query<Plan>("select * from plans where id = $1", [id]);
  return rows[0] ?? null;
}

export async function subscriberByUsername(db: Queryable, username: string): Promise<Subscriber | null> {
  const { rows } = await db.query<Subscriber>("select * from subscribers where username = $1", [username]);
  return rows[0] ?? null;
}

export async function subscriberById(db: Queryable, id: string): Promise<Subscriber | null> {
  const { rows } = await db.query<Subscriber>("select * from subscribers where id = $1", [id]);
  return rows[0] ?? null;
}

export async function entitlementsFor(db: Queryable, subscriberId: string): Promise<EntitlementView[]> {
  const { rows } = await db.query<{
    id: string;
    starts_at: Date;
    ends_at: Date;
    revoked_at: Date | null;
    download_kbps: number;
    upload_kbps: number;
    max_devices: number;
  }>(
    `select e.id, e.starts_at, e.ends_at, e.revoked_at, p.download_kbps, p.upload_kbps, p.max_devices
       from entitlements e join plans p on p.id = e.plan_id
      where e.subscriber_id = $1`,
    [subscriberId],
  );
  return rows.map((r) => ({
    id: r.id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    revokedAt: r.revoked_at,
    plan: { downloadKbps: r.download_kbps, uploadKbps: r.upload_kbps, maxDevices: r.max_devices },
  }));
}

export async function activeDeviceMacs(
  db: Queryable,
  subscriberId: string,
  freshSince: Date,
): Promise<string[]> {
  const { rows } = await db.query<{ calling_station_id: string }>(
    `select distinct calling_station_id from radius_sessions
      where subscriber_id = $1 and stopped_at is null and updated_at >= $2
        and calling_station_id is not null`,
    [subscriberId, freshSince],
  );
  return rows.map((r) => r.calling_station_id);
}

export async function createEntitlement(
  db: Queryable,
  e: { subscriberId: string; planId: string; startsAt: Date; durationSeconds: number; source: string },
): Promise<{ id: string; starts_at: Date; ends_at: Date }> {
  const endsAt = new Date(e.startsAt.getTime() + e.durationSeconds * 1000);
  const { rows } = await db.query<{ id: string; starts_at: Date; ends_at: Date }>(
    `insert into entitlements (subscriber_id, plan_id, starts_at, ends_at, source)
     values ($1, $2, $3, $4, $5) returning id, starts_at, ends_at`,
    [e.subscriberId, e.planId, e.startsAt, endsAt, e.source],
  );
  return rows[0]!;
}
