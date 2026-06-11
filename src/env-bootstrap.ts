/**
 * env-bootstrap — load ~/.tachi/.env (written by `tachi-agent setup`) as
 * process-env DEFAULTS at bin startup. Real environment variables always win;
 * a missing file is a no-op. TACHI_ENV_FILE overrides the path.
 *
 * The published bins read only process.env (the repo's npm scripts use
 * `node --env-file=.env`, which installed bins don't have), so without this
 * loader the wizard's env file would be inert.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "./service.js";

/** Apply `defaults` onto `env` without overriding keys already set. Pure. */
export function applyEnvDefaults(
  env: Record<string, string | undefined>,
  defaults: Record<string, string>,
): string[] {
  const applied: string[] = [];
  for (const [k, v] of Object.entries(defaults)) {
    if (env[k] === undefined) {
      env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}

/** Default location of the wizard-managed env file. */
export function userEnvPath(env: Record<string, string | undefined>, home = homedir()): string {
  return env.TACHI_ENV_FILE?.trim() || join(home, ".tachi", ".env");
}

/** Load the user env file into process.env as defaults. Missing file → no-op. */
export async function loadUserEnv(): Promise<void> {
  const path = userEnvPath(process.env as Record<string, string | undefined>);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }
  applyEnvDefaults(process.env as Record<string, string | undefined>, parseEnvFile(raw));
}
