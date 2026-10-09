// Proves the saved-address book (DoorDash/UberEats-style "deliver to"
// switcher) round-trips correctly and is properly owner-gated, and proves
// the real pre-existing security bug found while building it is actually
// fixed: update_profile used to let *any* agent overwrite *any other*
// agent's Profile, since validate_profile's update arm only checked
// content shape, never authorship. See profiles_integrity's own
// validate_profile_update doc comment.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, bytesEqual } from "./helpers.js";

const HOME = { lat: 41.9035, lon: -71.0898 };
const WORK = { lat: 42.3601, lon: -71.0589 };

await runScenario(async (scenario) => {
  const [customer, other] = await scenario.addPlayersWithApps([{ appBundleSource: appSource }, { appBundleSource: appSource }]);
  const both = [customer, other];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");

  const now = Date.now() * 1000;
  const customerProfile = await profilesOf(customer)<HcRecord>("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  const customerProfileRef = actionHash(customerProfile);
  await profilesOf(other)("create_profile", { display_name: "Otto Other", roles: ["Requester"], created_at: now });
  await dhtSync(both, customer.cells[0].cell_id[0]);

  // --- save_address / list_my_addresses / update_saved_address round-trip ---
  const homeRecord = await profilesOf(customer)<HcRecord>("save_address", {
    label: "Home",
    location: HOME,
    street: "32 Anawan St",
    city: "Taunton",
    state: "MA",
    zip: "02780",
  });
  const homeRef = actionHash(homeRecord);
  const stored = decodeEntry<{ label?: string; sealed?: unknown }>(homeRecord);
  assert.equal(stored.label, undefined, "the stored entry carries no label or address in the clear");
  assert.ok(stored.sealed, "it's sealed to its owner");
  await profilesOf(customer)("save_address", { label: "Work", location: WORK, street: "1 Main St", city: "Boston", state: "MA", zip: "02108" });
  await dhtSync(both, customer.cells[0].cell_id[0]);

  let mine = await profilesOf(customer)<{ original_action: Uint8Array; address: { label: string; street: string } }[]>("list_my_addresses", null);
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.map((v) => v.address.label).sort(), ["Home", "Work"]);
  console.log("[PASS] save_address + list_my_addresses round-trip both saved addresses, opened for their owner");

  await profilesOf(customer)<HcRecord>("update_saved_address", {
    original_action: homeRef,
    address: { label: "Home (updated)", location: HOME, street: "32 Anawan St Apt 2", city: "Taunton", state: "MA", zip: "02780" },
  });
  console.log("[PASS] update_saved_address accepts the owner's update");

  // original_action must stay stable across the update (same CatalogView-
  // shaped discipline applied here) -- re-list and confirm it's still
  // keyed the same way.
  mine = await profilesOf(customer)<{ original_action: Uint8Array; address: { label: string; street: string } }[]>("list_my_addresses", null);
  const homeView = mine.find((v) => bytesEqual(v.original_action, homeRef));
  assert.ok(homeView, "the updated address must still be discoverable under its original_action");
  assert.equal(homeView!.address.label, "Home (updated)");
  assert.equal(homeView!.address.street, "32 Anawan St Apt 2");
  console.log("[PASS] list_my_addresses opens the updated address under its stable original_action");

  // --- authorization: a non-owner cannot update or delete someone else's saved address ---
  await assert.rejects(
    profilesOf(other)("update_saved_address", {
      original_action: homeRef,
      address: { label: "Hijacked", location: HOME, street: "", city: "", state: "", zip: "" },
    }),
    "a non-owner must not be able to update someone else's saved address",
  );
  console.log("[PASS] validate() rejects a non-owner updating someone else's saved address");

  await profilesOf(other)("delete_saved_address", homeRef);
  await dhtSync(both, customer.cells[0].cell_id[0]);
  mine = await profilesOf(customer)<{ original_action: Uint8Array; address: { label: string; street: string } }[]>("list_my_addresses", null);
  assert.equal(mine.length, 2, "a non-owner's delete_saved_address call must not actually remove the real owner's link");
  console.log("[PASS] a non-owner's delete_saved_address call is a harmless no-op against someone else's address book");

  // --- delete_saved_address (as the real owner) actually removes it ---
  await profilesOf(customer)("delete_saved_address", homeRef);
  await dhtSync(both, customer.cells[0].cell_id[0]);
  mine = await profilesOf(customer)<{ original_action: Uint8Array; address: { label: string; street: string } }[]>("list_my_addresses", null);
  assert.equal(mine.length, 1);
  console.log("[PASS] delete_saved_address removes the address from the owner's own list_my_addresses");

  // --- the real bug: update_profile must now reject a non-owner ---
  await assert.rejects(
    profilesOf(other)("update_profile", {
      original_action: customerProfileRef,
      updated_profile: { display_name: "Hijacked Name", roles: ["Requester"], created_at: now, bio: "", avatar_data_uri: "", phone: "" },
    }),
    "a non-owner must not be able to update someone else's profile -- this used to silently succeed",
  );
  console.log("[PASS] validate() rejects a non-owner calling update_profile against someone else's profile (the real pre-existing bug this session found and fixed)");

  // Confirm the legitimate owner can still update their own profile fine.
  const ownUpdate = await profilesOf(customer)<HcRecord>("update_profile", {
    original_action: customerProfileRef,
    updated_profile: { display_name: "Cara C.", roles: ["Requester"], created_at: now, bio: "updated", avatar_data_uri: "", phone: "" },
  });
  assert.ok(ownUpdate, "the owner's update is accepted");
  assert.equal(await profilesOf(customer)<string | null>("get_my_name", null), "Cara C.", "and their (sealed) name is updated");
  console.log("[PASS] the real owner can still update their own profile after the authorization fix");
});
