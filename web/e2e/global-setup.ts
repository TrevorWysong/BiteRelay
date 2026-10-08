// Fails fast, with the fix, when the dev conductor isn't ready -- rather
// than every test timing out on a blank onboarding screen.
// @ts-expect-error -- a plain .mjs dev script, no type declarations
import { tryConnectAdmin } from "../scripts/lib/devEnv.mjs";
import { SEED_PEOPLE } from "./seed.ts";

export default async function globalSetup() {
  const admin = await tryConnectAdmin();
  if (!admin) {
    throw new Error("No dev conductor is running -- start one with `npm run dev:reset` (fresh + seeded) or `npm run dev:conductor`.");
  }
  try {
    const apps: { installed_app_id: string }[] = await admin.listApps({});
    const ids = new Set(apps.map((app) => app.installed_app_id));
    const missing = SEED_PEOPLE.filter((person) => !ids.has(person.appId));
    if (missing.length) {
      throw new Error(`The dev conductor isn't seeded (missing ${missing.map((p) => p.slug).join(", ")}) -- run \`npm run dev:reset\`.`);
    }
  } finally {
    await admin.client.close();
  }
}
