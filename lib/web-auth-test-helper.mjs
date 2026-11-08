// Test-only: isolated web login without touching the real credentials file.
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const credentials = require("../bin/web-credentials.js");
const AUTH_ENV = ["OMP_WEB_AUTH_FILE", "PI_WEB_PASSWORD", "PI_WEB_PASSWORD_FILE", "OMP_WEB_USERNAME", "OMP_WEB_REQUIRE_PASSWORD"];

async function isolate(t) {
  const directory = await mkdtemp(join(tmpdir(), "omp-web-auth-"));
  const saved = Object.fromEntries(AUTH_ENV.map((key) => [key, process.env[key]]));
  for (const key of AUTH_ENV) delete process.env[key];
  process.env.OMP_WEB_AUTH_FILE = join(directory, "credentials.json");
  t.after(async () => {
    for (const key of AUTH_ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await rm(directory, { recursive: true, force: true });
  });
  return process.env.OMP_WEB_AUTH_FILE;
}

/** Writes temporary credentials and returns a valid session Cookie header. */
export async function useTestWebLogin(t, { username = "tester", password = "test-only-password" } = {}) {
  const file = await isolate(t);
  await credentials.setWebCredentials(username, password);
  const token = credentials.createSessionToken(credentials.loadWebCredentials());
  return { cookie: `${credentials.SESSION_COOKIE}=${token}`, username, password, file };
}

/** No credentials configured at all. */
export async function useNoWebLogin(t) {
  return { file: await isolate(t) };
}
