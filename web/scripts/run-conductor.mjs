// A dev-only conductor launcher, replacing the `hc sandbox` dance the
// onboarding screen's "see the terminal output for the admin port" comment
// assumed you'd do by hand. `hc sandbox`'s own CLI can be flaky about tty
// access depending on how it's invoked; this reuses Tryorama's own,
// already-proven-reliable conductor-spawning machinery instead (the same
// code path every test in tests/tryorama/ runs on), just without tearing
// the conductor down afterward -- it stays up until you Ctrl+C it.
//
// Run from web/: node scripts/run-conductor.mjs
import { runScenario } from "@holochain-open-dev/tryorama";
import { fileURLToPath } from "node:url";

const HAPP_PATH = fileURLToPath(new URL("../public/relay.happ", import.meta.url));

console.log("Starting a real Holochain conductor for local dev...\n");

await runScenario(async (scenario) => {
  const conductor = await scenario.addConductor();

  // `adminApiUrl` is typed `private` in Tryorama's own .d.ts, but that's a
  // TypeScript-only annotation -- there's no real JS `#private` field here,
  // it's a plain property, and it's exactly the URL admin.ts needs.
  const adminUrl = conductor.adminApiUrl.href;

  console.log("================================================================");
  console.log("  Conductor is running. Paste this into Relay's onboarding screen:");
  console.log("");
  console.log(`  Conductor admin URL:  ${adminUrl}`);
  console.log("");
  console.log("  Leave this running -- Ctrl+C stops the conductor.");
  console.log("================================================================\n");

  // Keep the conductor alive until this process is killed. runScenario's
  // own teardown only runs once this callback resolves/rejects; hanging it
  // forever is what keeps the conductor up for a dev session instead of
  // Tryorama's normal "spin up, test, tear down" lifecycle. The explicit
  // shutDown() on SIGINT/SIGTERM matters -- without it the child
  // `holochain`/`lair-keystore` processes can outlive this script if the
  // terminal doesn't forward the signal to them itself.
  await new Promise((resolve) => {
    const stop = async () => {
      console.log("\nShutting down conductor...");
      await conductor.shutDown().catch(() => {});
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
});
