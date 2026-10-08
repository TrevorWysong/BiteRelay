// Runs the Tryorama suite: every src/*.test.ts (or just the names given),
// one file at a time.
//
//   node run.mjs                  every test file
//   node run.mjs reviews chat     just these (file names without .test.ts)
//   TEST_TIMEOUT_MIN=15 node run.mjs
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
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const logDir = join(here, ".logs");
const timeoutMs = Number(process.env.TEST_TIMEOUT_MIN ?? 10) * 60_000;
const retries = Number(process.env.TEST_RETRIES ?? 1);
const FAILURE = /error occurred during test run|AssertionError|Error: Request timed out/;

const wanted = process.argv.slice(2);
const all = readdirSync(join(here, "src"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => f.replace(/\.test\.ts$/, ""))
  .sort();
const unknown = wanted.filter((name) => !all.includes(name));
if (unknown.length) {
  console.error(`No such test file: ${unknown.join(", ")}`);
  process.exit(2);
}
const files = wanted.length ? wanted : all;

if (!existsSync(join(repo, "workdir/relay.happ"))) {
  console.error("workdir/relay.happ is missing -- run `npm run backend` in web/ (or hc dna pack / hc app pack) first.");
  process.exit(2);
}
if (files.includes("link-validation") && !existsSync(join(repo, "target/test-utils/wasm32-unknown-unknown/release"))) {
  console.error("link-validation needs the test-utils coordinators -- run `npm run build:test-coordinators` first.");
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
      const reason = failed ? (output.match(/(AssertionError[^\n]*|Error:[^\n]*|Timed out after[^\n]*)/)?.[0] ?? `exit code ${code}`) : null;
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

const failed = results.filter((r) => r.status === "FAIL");
const flaky = results.filter((r) => r.status === "FLAKY");
console.log(`\n${results.length - failed.length}/${results.length} files passed${flaky.length ? ` (${flaky.length} only on retry: ${flaky.map((r) => r.name).join(", ")})` : ""}.`);
process.exit(failed.length ? 1 : 0);
