export interface Config {
  databaseUrl: string;
  port: number;
  adminApiToken: string;
  radiusApiToken: string;
  staleSessionMinutes: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    port: Number(env.PORT ?? 8080),
    adminApiToken: required(env, "ADMIN_API_TOKEN"),
    radiusApiToken: required(env, "RADIUS_API_TOKEN"),
    staleSessionMinutes: Number(env.STALE_SESSION_MINUTES ?? 15),
  };
}
