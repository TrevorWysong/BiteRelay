// Runs the Tryorama suite: every src/*.test.ts (or just the names given),
// one file at a time.
//
//   node run.mjs                  every test file
//   node run.mjs reviews chat     just these (file names without .test.ts)
//   node run.mjs --shard 2/4      the second of four even shares (for CI)
//   node run.mjs --record         also save each passing file's duration
//   node run.mjs --shard 2/4 --list   just print which files would run
//   TEST_TIMEOUT_MIN=15 node run.mjs
//
// Shards are balanced by how long each file takes on CI (durations.json),
// so parallel CI jobs finish together. Those are CI's timings, 2-3 times a
// laptop's: refresh them from a CI run's summary, or with `--record` run on
// CI -- a local `--record` would understate every file.
//
// Each file spins up its own conductors, which are heavy -- running them
// concurrently is what made the suite flaky (SQLite "database is locked",
// 60s zome-call timeouts). So files run serially, and after each one any
// conductor or keystore it left behind is killed and its temp dirs removed,
// so a crashed file can't slow down every file after it.
//
// `runScenario` logs a failed scenario and still exits 0, so a file fails
// if it exits non-zero *or* its output reports an error. A failing file is
// retried once; one that passes on retry is reported as flaky, not hidden.
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const logDir = join(here, ".logs");
const timeoutMs = Number(process.env.TEST_TIMEOUT_MIN ?? 10) * 60_000;
const retries = Number(process.env.TEST_RETRIES ?? 1);
const FAILURE = /error occurred during test run|AssertionError|Error: Request timed out/;

const args = process.argv.slice(2);
const record = args.includes("--record");
const shardArg = args.find((arg, i) => args[i - 1] === "--shard");
const wanted = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--shard");
const all = readdirSync(join(here, "src"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => f.replace(/\.test\.ts$/, ""))
  .sort();
const unknown = wanted.filter((name) => !all.includes(name));
if (unknown.length) {
  console.error(`No such test file: ${unknown.join(", ")}`);
  process.exit(2);
}

const durationsPath = join(here, "durations.json");
const durations = existsSync(durationsPath) ? JSON.parse(readFileSync(durationsPath, "utf8")) : {};
/// A file with no recorded duration counts as a typical one.
const DEFAULT_SECONDS = 60;

/// Splits `names` into `count` shares of about equal total duration: longest
/// first, each to the share with the least so far. Deterministic, so every
/// CI job computes the same split.
function shards(names, count) {
  const shares = Array.from({ length: count }, () => ({ names: [], seconds: 0 }));
  const longestFirst = [...names].sort((a, b) => (durations[b] ?? DEFAULT_SECONDS) - (durations[a] ?? DEFAULT_SECONDS) || a.localeCompare(b));
  for (const name of longestFirst) {
    const lightest = shares.reduce((min, share) => (share.seconds < min.seconds ? share : min));
    lightest.names.push(name);
    lightest.seconds += durations[name] ?? DEFAULT_SECONDS;
  }
  return shares.map((share) => share.names.sort());
}

let files = wanted.length ? wanted : all;
if (shardArg) {
  const [index, count] = shardArg.split("/").map(Number);
  if (!(count >= 1 && index >= 1 && index <= count)) {
    console.error(`--shard takes i/n with 1 <= i <= n, not "${shardArg}"`);
    process.exit(2);
  }
  files = shards(files, count)[index - 1];
  const seconds = files.reduce((sum, name) => sum + (durations[name] ?? DEFAULT_SECONDS), 0);
  console.log(`shard ${index}/${count}: ${files.length} files, about ${Math.round(seconds / 60)} minutes\n`);
}
if (args.includes("--list")) {
  console.log(files.join("\n"));
  process.exit(0);
}

if (!existsSync(join(repo, "workdir/handshake.happ"))) {
  console.error("workdir/handshake.happ is missing -- run `npm run backend` in web/ (or hc dna pack / hc app pack) first.");
  process.exit(2);
}
// Files that hot-swap in the test-only coordinator build (useTestCoordinators).
const needing = files.filter((name) => readFileSync(join(here, "src", `${name}.test.ts`), "utf8").includes("useTestCoordinators("));
if (needing.length && !existsSync(join(repo, "target/test-utils/wasm32-unknown-unknown/release"))) {
  console.error(`${needing.join(", ")} need the test-utils coordinators -- run \`npm run build:test-coordinators\` first.`);
  process.exit(2);
}
mkdirSync(logDir, { recursive: true });

/// Conductor and keystore processes running out of the OS temp dir --
/// i.e. a test's, never the persistent dev conductor (which lives in .dev/).
function strayProcesses() {
  try {
    return execFileSync("pgrep", ["-f", `(holochain|lair-keystore).*${tmpdir()}`], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/// Temp dirs a test run created: ones that didn't exist before it started.
function tempDirs() {
  try {
    return new Set(readdirSync(tmpdir()));
  } catch {
    return new Set();
  }
}

function cleanUp(before) {
  for (const pid of strayProcesses()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const name of tempDirs()) {
    if (before.has(name)) continue;
    const path = join(tmpdir(), name);
    try {
      // Only directories a conductor or keystore wrote into.
      const isConductorDir = statSync(path).isDirectory() && readdirSync(path).some((f) => /conductor|lair|keystore|databases/.test(f));
      if (isConductorDir) rmSync(path, { recursive: true, force: true });
    } catch {
      // vanished or not ours
    }
  }
}

function runOnce(name, attempt) {
  return new Promise((resolve) => {
    const log = join(logDir, `${name}${attempt ? `.retry${attempt}` : ""}.log`);
    const out = createWriteStream(log);
    const before = tempDirs();
    const started = Date.now();
    const child = spawn("npx", ["tsx", `src/${name}.test.ts`], { cwd: here, env: process.env });
    let output = "";
    // `runScenario` can report a failure and then leave its conductors
    // running; once it has, give it a moment to finish logging, then stop it
    // instead of waiting out the whole timeout.
    let reported = null;
    const collect = (chunk) => {
      output += chunk;
      out.write(chunk);
      if (!reported && FAILURE.test(output)) reported = setTimeout(() => child.kill("SIGKILL"), 15_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      output += `\nTimed out after ${timeoutMs / 60_000} minutes\n`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(reported);
      out.end();
      cleanUp(before);
      const passes = (output.match(/\[PASS\]/g) ?? []).length;
      const failed = code !== 0 || FAILURE.test(output) || /Timed out after/.test(output);
      // The error's first line, and what it was compared against -- an
      // assertion's "Input:" or "actual:" -- on one line, so a CI summary
      // says what went wrong without the log.
      const found = output.match(/(AssertionError|Error:|Timed out after)[\s\S]{0,600}/)?.[0];
      const reason = failed ? (found ? found.replace(/\s+/g, " ").slice(0, 400) : `exit code ${code}`) : null;
      resolve({ passes, failed, reason, seconds: Math.round((Date.now() - started) / 1000), log });
    });
  });
}

const results = [];
for (const name of files) {
  let result = await runOnce(name, 0);
  let attempt = 0;
  while (result.failed && attempt < retries) {
    attempt += 1;
    console.log(`retry ${name} (${result.reason})`);
    result = await runOnce(name, attempt);
  }
  const status = result.failed ? "FAIL " : attempt > 0 ? "FLAKY" : "ok   ";
  console.log(`${status} ${name.padEnd(28)} ${String(result.passes).padStart(2)} passes  ${result.seconds}s${result.failed ? `  -- ${result.reason}\n      log: ${result.log}` : ""}`);
  results.push({ name, status: status.trim(), ...result });
}

if (record) {
  for (const r of results) if (r.status === "ok") durations[r.name] = r.seconds;
  const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(durationsPath, `${JSON.stringify(sorted, null, 2)}\n`);
}

const failed = results.filter((r) => r.status === "FAIL");
const flaky = results.filter((r) => r.status === "FLAKY");
console.log(`\n${results.length - failed.length}/${results.length} files passed${flaky.length ? ` (${flaky.length} only on retry: ${flaky.map((r) => r.name).join(", ")})` : ""}.`);
process.exit(failed.length ? 1 : 0);
