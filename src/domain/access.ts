// The access decision is kept free of I/O so the rules can be read and tested on their own.

export interface PlanLimits {
  downloadKbps: number;
  uploadKbps: number;
  maxDevices: number;
}

export interface EntitlementView {
  id: string;
  startsAt: Date;
  endsAt: Date;
  revokedAt: Date | null;
  plan: PlanLimits;
}

export interface AccessRequest {
  subscriber: { siteId: string; disabled: boolean };
  siteId: string;
  entitlements: EntitlementView[];
  // MAC addresses of this subscriber's devices that already have a live session.
  activeDeviceMacs: string[];
  mac: string | null;
  now: Date;
}

export type RejectReason = "account_disabled" | "wrong_site" | "no_active_plan" | "device_limit";

export type AccessDecision =
  | {
      allowed: true;
      entitlementId: string;
      sessionTimeoutSeconds: number;
      downloadKbps: number;
      uploadKbps: number;
    }
  | { allowed: false; reason: RejectReason };

export const REJECT_MESSAGES: Record<RejectReason, string> = {
  account_disabled: "This account has been disabled. Please contact ZiFii support.",
  wrong_site: "This account is not registered at this location.",
  no_active_plan: "You have no active plan. Please buy or redeem one.",
  device_limit: "Your plan's device limit has been reached. Disconnect another device and try again.",
};

export function isActive(e: EntitlementView, now: Date): boolean {
  return e.revokedAt === null && e.startsAt <= now && now < e.endsAt;
}

// The fastest active plan wins; between equals, the one that lasts longest.
export function bestEntitlement(entitlements: EntitlementView[], now: Date): EntitlementView | null {
  let best: EntitlementView | null = null;
  for (const e of entitlements) {
    if (!isActive(e, now)) continue;
    if (
      !best ||
      e.plan.downloadKbps > best.plan.downloadKbps ||
      (e.plan.downloadKbps === best.plan.downloadKbps && e.endsAt > best.endsAt)
    ) {
      best = e;
    }
  }
  return best;
}

export function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return mac.toLowerCase();
  return hex.match(/../g)!.join(":");
}

export function decideAccess(req: AccessRequest): AccessDecision {
  if (req.subscriber.disabled) return { allowed: false, reason: "account_disabled" };
  if (req.subscriber.siteId !== req.siteId) return { allowed: false, reason: "wrong_site" };

  const entitlement = bestEntitlement(req.entitlements, req.now);
  if (!entitlement) return { allowed: false, reason: "no_active_plan" };

  const mac = normalizeMac(req.mac);
  const others = new Set(req.activeDeviceMacs.map(normalizeMac).filter((m): m is string => m !== null));
  // A device that already has a session is reconnecting, not adding to the count.
  if (!(mac && others.has(mac)) && others.size >= entitlement.plan.maxDevices) {
    return { allowed: false, reason: "device_limit" };
  }

  return {
    allowed: true,
    entitlementId: entitlement.id,
    sessionTimeoutSeconds: Math.max(1, Math.ceil((entitlement.endsAt.getTime() - req.now.getTime()) / 1000)),
    downloadKbps: entitlement.plan.downloadKbps,
    uploadKbps: entitlement.plan.uploadKbps,
  };
}
