// Local updater receipts. No credentials or raw environment/config values are persisted.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const revision = 1;
const receipts = { dependencies: "node_modules/.omp-web-install.json", build: ".next/.omp-web-build.json" };
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const contents = (path) => existsSync(path) ? readFileSync(path, "utf8") : null;

export function dependencyKey(root, runtime) {
  return digest([revision, runtime, contents(join(root, "package.json")), contents(join(root, "package-lock.json"))]);
}

export function buildKey(root, dependencies, commit, env = process.env) {
  const buildEnv = Object.keys(env).filter((key) => /^(NEXT_|NODE_|npm_config_)/i.test(key) || key === "CI")
    .sort().map((key) => [key, env[key]]);
  return digest([revision, dependencies, commit, buildEnv,
    [".env", ".env.local", ".env.production", ".env.production.local"].map((name) => [name, contents(join(root, name))])]);
}

function dependencyEvidence(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packages = { ...pkg.dependencies, ...pkg.devDependencies };
  const versions = Object.keys(packages).sort().map((name) => {
    const installed = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
    return [name, installed.version];
  });
  for (const name of ["next", "tsc"]) statSync(join(root, "node_modules/.bin", name));
  const lock = readFileSync(join(root, "node_modules/.package-lock.json"), "utf8");
  return digest([versions, lock]);
}

function buildEvidence(root) {
  for (const name of ["BUILD_ID", "build-manifest.json", "routes-manifest.json", "prerender-manifest.json", "required-server-files.json"]) {
    if (!statSync(join(root, ".next", name)).isFile()) throw new Error(`Missing ${name}`);
  }
  for (const name of ["server", "static"]) {
    if (!statSync(join(root, ".next", name)).isDirectory()) throw new Error(`Missing ${name}`);
  }
  // Check output inventory without rereading large bundles. Also detects an external rebuild.
  const files = [];
  function walk(relative) {
    for (const entry of readdirSync(join(root, ".next", relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && ["cache", "dev", "diagnostics", "trace", "trace-build", ".omp-web-build.json"].includes(entry.name)) continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const stat = statSync(join(root, ".next", path));
        files.push([path, stat.size, stat.mtimeMs]);
      }
    }
  }
  walk("");
  return digest(files);
}

const evidence = (root, kind) => kind === "dependencies" ? dependencyEvidence(root) : buildEvidence(root);

export function reusable(root, kind, key) {
  try {
    const receipt = JSON.parse(readFileSync(join(root, receipts[kind]), "utf8"));
    return receipt.key === key && receipt.evidence === evidence(root, kind);
  } catch { return false; }
}

export function recordSuccess(root, kind, key) {
  const receipt = { key, evidence: evidence(root, kind) };
  const path = join(root, receipts[kind]);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(receipt) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

function main() {
  const [action, kind, key] = process.argv.slice(2);
  const root = process.cwd();
  if (action === "keys") {
    const npm = (...args) => execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const runtime = { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch,
      npm: npm("--version"), config: npm("config", "list", "--json"), nodeOptions: process.env.NODE_OPTIONS ?? "" };
    const dependencies = dependencyKey(root, runtime);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    console.log(`${dependencies} ${buildKey(root, dependencies, commit)}`);
  } else if (Object.hasOwn(receipts, kind) && key) {
    if (action === "check") process.exitCode = reusable(root, kind, key) ? 0 : 1;
    else if (action === "record") recordSuccess(root, kind, key);
    else throw new Error("Unknown action");
  } else throw new Error("Invalid updater state arguments");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch {
    // npm config and environment may contain secrets; never echo exceptions here.
    console.error("Could not inspect/save updater state; no successful state was assumed.");
    process.exitCode = 1;
  }
}
