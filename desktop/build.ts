// Builds HandShake's desktop app -- an installer that runs its own Holochain
// node, so nobody needs a website or a launcher -- with Kangaroo
// (holochain/kangaroo-electron), pinned below.
//
//   node desktop/build.ts mac-arm64 | mac-x64 | win | linux
//   node desktop/build.ts dev          (runs it, unpackaged)
//
// It needs deploy/handshake.webhapp built for network.json's network first:
//
//   cd web && npm run package -- --network ../desktop/network.json
//
// Kangaroo is a template meant to be forked; this keeps only what's
// HandShake's own (kangaroo.config.ts, network.json) and lays it over a
// fresh copy of Kangaroo in desktop/.kangaroo, with three fixes (`PATCHES`).
// Installers land in desktop/.kangaroo/dist. Releasing is
// .github/workflows/desktop.yml.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(DESKTOP);
const KANGAROO = path.join(DESKTOP, ".kangaroo");
const WEBHAPP = path.join(REPO, "deploy/handshake.webhapp");

/// Kangaroo's main branch (its Holochain 0.7 line). Bump deliberately, and
/// re-check that every patch still applies -- this script fails if one doesn't.
const KANGAROO_COMMIT = "68019666ad5c09e2dcdbe1a78e8ac4cdff1537c8";

/// Where releases (and so auto-updates) live: this repo, or the one CI runs in.
const RELEASES = process.env.GITHUB_REPOSITORY ?? "TrevorWysong/HandShake";
const [OWNER, NAME] = RELEASES.split("/");

const PATCHES = [
  {
    // Kangaroo installs the hApp with one network seed for every role. Ours
    // carries its seeds already (package.ts), and a migration release has
    // two roles on different seeds -- overriding both would put the
    // `previous` role on the wrong network.
    file: "src/main/holochainManager.ts",
    from: "      network_seed: networkSeed,\n",
    to: "",
  },
  {
    // Its macOS update-manifest merge is hardcoded to Holochain's launcher.
    file: "scripts/merge-mac-yamls.mjs",
    from: "const OWNER = 'holochain';\nconst REPO = 'launcher';",
    to: `const OWNER = '${OWNER}';\nconst REPO = '${NAME}';`,
  },
  {
    // Releases, and the auto-updater's checks, go to this repo's GitHub.
    file: "templates/electron-builder-template.yml",
    from: "# publish:\n#   provider: generic\n#   url: https://example.com/auto-updates",
    to: `publish:\n  provider: github\n  owner: ${OWNER}\n  repo: ${NAME}`,
  },
  {
    file: "templates/electron-builder-template.yml",
    from: "  maintainer: electronjs.org",
    to: `  maintainer: ${OWNER}`,
  },
];

const TARGETS: Record<string, string> = { "mac-arm64": "build:mac-arm64", "mac-x64": "build:mac-x64", win: "build:win", linux: "build:linux", dev: "dev" };
const target = process.argv[2] ?? "";
const script = TARGETS[target];
if (!script) fail(`Pass a target: ${Object.keys(TARGETS).join(", ")}.`);
if (!existsSync(WEBHAPP)) fail("deploy/handshake.webhapp is missing -- run `npm run package -- --network ../desktop/network.json` in web/ first.");

fetchKangaroo();
copyFileSync(path.join(DESKTOP, "kangaroo.config.ts"), path.join(KANGAROO, "kangaroo.config.ts"));
for (const { file, from, to } of PATCHES) {
  const at = path.join(KANGAROO, file);
  const text = readFileSync(at, "utf8");
  if (!text.includes(from)) fail(`Kangaroo's ${file} no longer has what desktop/build.ts patches -- check the patch against KANGAROO_COMMIT.`);
  writeFileSync(at, text.replace(from, to));
}
// The one webhapp in its pouch: ours.
copyFileSync(WEBHAPP, path.join(KANGAROO, "pouch/handshake.webhapp"));

run("yarn", ["setup"]);
run("yarn", [script]);

/// A fresh copy of Kangaroo at KANGAROO_COMMIT, every build, so no earlier
/// build's patches linger -- a tarball, not a clone, so there's no git remote
/// of Kangaroo's around for electron-builder to publish to.
function fetchKangaroo() {
  rmSync(KANGAROO, { recursive: true, force: true });
  mkdirSync(KANGAROO, { recursive: true });
  const tarball = path.join(DESKTOP, ".kangaroo.tar.gz");
  run("curl", ["-fsSL", "-o", tarball, `https://codeload.github.com/holochain/kangaroo-electron/tar.gz/${KANGAROO_COMMIT}`], DESKTOP);
  run("tar", ["-xzf", tarball, "-C", KANGAROO, "--strip-components=1"], DESKTOP);
  rmSync(tarball);
}

function run(cmd: string, args: string[], cwd = KANGAROO) {
  console.log(`\n▸ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
