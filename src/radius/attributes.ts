// FreeRADIUS rlm_rest sends attributes as {"User-Name": {"type": "string", "value": ["alice"]}}.
// Flat {"User-Name": "alice"} is accepted too, which keeps manual testing with curl simple.
export type RadiusAttributes = Record<string, string>;

export function parseRadiusBody(body: unknown): RadiusAttributes {
  const out: RadiusAttributes = {};
  if (!body || typeof body !== "object") return out;
  for (const [name, raw] of Object.entries(body as Record<string, unknown>)) {
    let value: unknown = raw;
    if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
      value = (value as { value: unknown }).value;
    }
    if (Array.isArray(value)) value = value[0];
    if (value === undefined || value === null) continue;
    out[name] = String(value);
  }
  return out;
}

export function octets(attrs: RadiusAttributes, direction: "Input" | "Output"): number {
  const low = Number(attrs[`Acct-${direction}-Octets`] ?? 0);
  const high = Number(attrs[`Acct-${direction}-Gigawords`] ?? 0);
  return high * 2 ** 32 + low;
}

// Reply attributes for an accepted login. WISPr is understood by most hotspot gear;
// Mikrotik-Rate-Limit is "rx/tx" from the router's side, i.e. upload/download for the client.
export function acceptReply(d: { sessionTimeoutSeconds: number; downloadKbps: number; uploadKbps: number }) {
  return {
    "reply:Session-Timeout": d.sessionTimeoutSeconds,
    "reply:WISPr-Bandwidth-Max-Down": d.downloadKbps * 1000,
    "reply:WISPr-Bandwidth-Max-Up": d.uploadKbps * 1000,
    "reply:Mikrotik-Rate-Limit": `${d.uploadKbps}k/${d.downloadKbps}k`,
    "reply:Acct-Interim-Interval": 300,
  };
}
