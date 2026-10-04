import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import type { Db } from "./db.js";
import { tokensMatch } from "./domain/passwords.js";
import { registerRadiusRoutes } from "./routes/radius.js";
import { registerAdminRoutes } from "./routes/admin.js";

export interface AppOptions {
  db: Db;
  adminApiToken: string;
  radiusApiToken: string;
  staleSessionMinutes: number;
  now?: () => Date;
  logger?: boolean;
}

export interface AppContext {
  db: Db;
  now: () => Date;
  staleSessionMinutes: number;
}

export function bearerGuard(token: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!given || !tokensMatch(given, token)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const ctx: AppContext = { db: opts.db, now: opts.now ?? (() => new Date()), staleSessionMinutes: opts.staleSessionMinutes };

  app.get("/health", async () => {
    await opts.db.query("select 1");
    return { ok: true };
  });

  app.register(async (scope) => {
    scope.addHook("onRequest", bearerGuard(opts.radiusApiToken));
    registerRadiusRoutes(scope, ctx);
  }, { prefix: "/radius" });

  app.register(async (scope) => {
    scope.addHook("onRequest", bearerGuard(opts.adminApiToken));
    registerAdminRoutes(scope, ctx);
  }, { prefix: "/admin" });

  return app;
}
