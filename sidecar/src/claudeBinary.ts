/**
 * Résolution du `claude` système : le binaire embarqué du SDK n'a pas de
 * moteur de mods, Den doit donc lancer celui de l'utilisateur (>= MIN).
 */
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

export const MIN_CLAUDE_VERSION = "2.1.291";

export type ResolvedClaude =
  | { ok: true; path: string; version: string }
  | { ok: false; reason: string };

export interface ResolveDeps {
  exists(path: string): Promise<boolean>;
  exec(file: string, args: string[]): Promise<string>;
}

const defaultDeps: ResolveDeps = {
  exists: (path) =>
    access(path, constants.X_OK).then(
      () => true,
      () => false,
    ),
  exec: (file, args) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { timeout: 5000 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    }),
};

type Semver = [number, number, number];

function parseVersion(output: string): Semver | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v: Semver, min: Semver): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i]! > min[i]!;
  }
  return true;
}

async function findInPath(env: NodeJS.ProcessEnv, deps: ResolveDeps): Promise<string | null> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "claude");
    if (await deps.exists(candidate)) return candidate;
  }
  return null;
}

export async function resolveClaudeBinary(
  env: NodeJS.ProcessEnv,
  deps: ResolveDeps = defaultDeps,
): Promise<ResolvedClaude> {
  const explicit = env.DEN_CLAUDE_PATH;
  let path: string | null;
  if (explicit) {
    path = (await deps.exists(explicit)) ? explicit : null;
    if (!path) return { ok: false, reason: `DEN_CLAUDE_PATH introuvable: ${explicit}` };
  } else {
    path = await findInPath(env, deps);
    if (!path) return { ok: false, reason: "claude introuvable dans le PATH" };
  }

  let output: string;
  try {
    output = await deps.exec(path, ["--version"]);
  } catch (err) {
    return { ok: false, reason: `${path} --version a échoué: ${String(err)}` };
  }
  const parsed = parseVersion(output);
  if (!parsed) return { ok: false, reason: `version illisible: ${output.trim()}` };
  const version = parsed.join(".");
  if (!atLeast(parsed, parseVersion(MIN_CLAUDE_VERSION)!)) {
    return { ok: false, reason: `claude ${version} < ${MIN_CLAUDE_VERSION} (mods requis)` };
  }
  return { ok: true, path, version };
}
