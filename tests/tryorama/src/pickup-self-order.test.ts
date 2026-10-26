// A merchant ordering pickup from their own restaurant -- legitimate (see
// settle_order_total's own comment) and exactly what a single-agent dev
// session does, since one agent holds customer and merchant modes at once.
// complete_pickup must succeed: the merchant-reputation event it would
// normally record has subject == counterparty here, which
// reputation_integrity::validate_event rejects, so it has to be skipped
// rather than allowed to fail the completion.
import assert from "node:assert/strict";
import { runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, decodeEntry, ST_PETE, testApp, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [owner] = await scenario.addPlayersWithApps([testApp]);

  const profiles = retryingCaller(owner.cells[0], "profiles");
  const catalog = retryingCaller(owner.cells[0], "catalog");
  const dispatch = retryingCaller(owner.cells[0], "dispatch");

  await profiles("create_profile", { display_name: "Solo Owner", roles: ["Requester", "Merchant"], created_at: Date.now() * 1000 });
  const catalogRef = actionHash(await catalog<HcRecord>("publish_catalog", { business_name: "Solo's Diner", location: ST_PETE }));
  const itemRef = actionHash(await catalog<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Burger", price_cents: 900, available: true }));

  const orderRef = actionHash(
    await dispatch<HcRecord>("request_pickup_order", {
      merchant: owner.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: itemRef, quantity: 1 }],
      order_total: 900,
    }),
  );
  await dispatch("accept_pickup_order", { order_original_action: orderRef });
  await dispatch("mark_ready_for_pickup", orderRef);

  await dispatch("complete_pickup", orderRef);
  const done = decodeEntry<{ status: string }>(await dispatch<HcRecord>("get_pickup_order", orderRef));
  assert.equal(done.status, "PickedUp");
  console.log("[PASS] complete_pickup succeeds on a self-order");
});
