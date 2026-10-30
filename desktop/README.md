# HandShake for desktop

HandShake as an app people download: macOS (Apple Silicon and Intel), Windows and Linux. Each install runs its own Holochain node and keystore, so there's no website to host and no launcher to install first. It's built with [Kangaroo](https://github.com/holochain/kangaroo-electron), Holochain's Electron template.

Closing the window keeps HandShake running from the menu bar or system tray, so a store's orders still arrive and its upkeep still runs. Quit from the tray icon to stop it.

## What's here

| File | What it is |
| --- | --- |
| `network.json` | The network the app joins: its seed, its bootstrap and relay server, and its DNA properties. The bundle is packaged from this file (`npm run package -- --network ../desktop/network.json`) and the app's config reads it too, so the two can't disagree. |
| `kangaroo.config.ts` | The app's identity (`appId`, name, version), its Holochain version and the binaries' SHA-256 hashes. |
| `build.ts` | Lays those over a fresh copy of Kangaroo at a pinned commit, applies three fixes, and builds. |

Kangaroo is meant to be forked. Keeping only HandShake's own files here, with Kangaroo fetched at a pinned commit, keeps the repo small and makes updating Kangaroo a one-line change. The fixes `build.ts` applies:

- **The network seed.** Kangaroo installs the hApp with one seed for every role. HandShake's bundle carries its own seeds, and an upgrade release has two roles on different seeds (docs/MIGRATION.md), so the override is removed.
- **Updates.** Releases and the app's update checks point at this repo's GitHub, not Kangaroo's.
- **The macOS update manifest**, which Kangaroo's script merges for Holochain's own launcher repo.

If a Kangaroo update changes what a fix touches, `build.ts` stops and says which one.

## Releasing

1. **Version.** Bump `version` in `kangaroo.config.ts`. Versions that are semver-compatible share one node and its data (0.1.0 to 0.1.4). A breaking bump (0.1 to 0.2) starts a separate, empty one, so bump the minor only for a new network or a new Holochain line.
2. **Build.** In GitHub, Actions, **Desktop**, Run workflow. It packages the bundle once, drafts release `v<version>`, and builds the four installers into it.
3. **Publish** the draft once you've tried an installer. Installed apps find it on their next start and offer to update.

To try a build on your own machine, package the bundle, then `node desktop/build.ts dev` (or `mac-arm64`, `mac-x64`, `win`, `linux`). It needs Yarn 1 (`npm i -g yarn`).

## Before real users

- **The servers.** `network.json` uses Holochain's public test server, which is fine for trying it out and is not for production: it has low bandwidth and no uptime guarantee. Point it at the network's own server (docs/DEPLOYMENT.md, `deploy/`) before anyone relies on it. Changing the server after people have installed splits them into separate networks, so do it with a new network seed and a breaking version bump.
- **Signing.** Builds are unsigned for now.
  - **macOS** quarantines unsigned apps, so opening one takes `xattr -r -d com.apple.quarantine /Applications/HandShake.app`. Signing needs an Apple Developer account ($99 a year): set `macOSCodeSigning: true`, add the `APPLE_*` secrets Kangaroo's README lists, and bring over its certificate-import and notarize steps into `.github/workflows/desktop.yml`.
  - **Windows** shows a SmartScreen warning ("More info", then "Run anyway"). Signing needs a certificate: set `windowsEVCodeSigning: true`, add the `AZURE_*` secrets, and bring over Kangaroo's signing step.
  - **Linux** needs nothing.
- **The issuer.** Funds come from the issuer named in the properties. Its conductor has to run on the same network (seed and servers) as the app, or nobody can top up.
