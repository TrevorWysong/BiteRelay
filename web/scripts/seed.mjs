// Creates a realistic demo world on the dev conductor in one go, so a reset
// costs seconds instead of an afternoon of re-onboarding by hand:
//
//   npm run seed                      around the app's default location
//   npm run seed -- --at 41.63,-70.93 around any lat,lon
//
// Everything is created through the same zome calls the UI makes, so the
// data is real (validated, signed, linked) -- not fixtures. The world is
// declared as plain data (WORLD, in lib/world.mjs); this script just plays it.
//
// Every identity's installed app id starts with "seed-"; the onboarding
// screen's dev identity picker lists them so you can sign in as anyone.
import { readFileSync, writeFileSync } from "node:fs";
import { AppWebsocket, encodeHashToBase64 } from "@holochain/client";
import { decode } from "@msgpack/msgpack";
import { DEV_NETWORK, DNA_PATH, ISSUER_APP_ID, SERVED_HAPP, WS_OPTIONS, appInterfacePort, connectAdmin, dnaHashOf, rolesSettingsFor } from "./lib/devEnv.mjs";
import { WORLD } from "./lib/world.mjs";

const DEFAULT_CENTER = { lat: 27.7676, lon: -82.6403 }; // matches session.ts's default browse location

const ROLE = "relay";
/// The seeded stores' time zone -- the default location is St. Petersburg, FL.
const SEED_TIME_ZONE = "America/New_York";
const SEED_PREFIX = "seed-";

// ----------------------------------------------------------------- engine
function parseCenter() {
  const i = process.argv.indexOf("--at");
  if (i === -1) return DEFAULT_CENTER;
  const [lat, lon] = (process.argv[i + 1] ?? "").split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("--at expects lat,lon (e.g. --at 41.63,-70.93)");
  return { lat, lon };
}

/// km offsets (east, north) -> a point near `center`.
function near(center, [eastKm, northKm]) {
  const lat = center.lat + northKm / 110.574;
  const lon = center.lon + eastKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
  return { lat, lon };
}

const now = () => Date.now() * 1000;
const hash = (record) => record.signed_action.hashed.hash;

/// Retries until a call stops failing -- for reads/validations that depend
/// on another agent's just-written data having gossiped over.
async function eventually(label, fn, attempts = 40, delayMs = 500) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw new Error(`${label}: ${err?.message ?? err}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/// A delivery's status as `agent` reads it.
async function statusOf(agent, orderRef) {
  const record = await agent.call("dispatch", "get_order", orderRef);
  return decode(record.entry.Present.entry).status;
}

/// A step each party's own app also takes as soon as it can -- the driver
/// committing, the store cooking, the driver picking up: done here too, and
/// done if their app already did it.
async function stepOrDone(label, fn, alreadyDone) {
  return eventually(label, async () => {
    try {
      return await fn();
    } catch (err) {
      if (!alreadyDone.test(String(err?.message ?? err))) throw err;
    }
  });
}

/// A ledger amount: dollars, as cents.
const dollars = (n) => Math.round(n * 100);

async function createAgent(adminWs, appPort, happBytes, person, network, agentKey = null, appIdOverride = null) {
  agentKey ??= await adminWs.generateAgentPubKey();
  // The onboarding picker turns "seed-mo-haddad" back into "Mo Haddad".
  const appId = appIdOverride ?? `${SEED_PREFIX}${person.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  await adminWs.installApp({ source: { type: "bytes", value: happBytes }, agent_key: agentKey, installed_app_id: appId, roles_settings: rolesSettingsFor(network) });
  const appInfo = await adminWs.enableApp({ installed_app_id: appId });
  const cellId = appInfo.cell_info[ROLE][0].value.cell_id;
  await adminWs.authorizeSigningCredentials(cellId);
  const { token } = await adminWs.issueAppAuthenticationToken({ installed_app_id: appId });
  const appWs = await AppWebsocket.connect({ url: new URL(`ws://localhost:${appPort}`), token, wsClientOptions: WS_OPTIONS, defaultTimeout: 60_000 });
  const call = (zome, fn, payload = null) => appWs.callZome({ cell_id: cellId, zome_name: zome, fn_name: fn, payload });
  return { ...person, appId, key: agentKey, cellId, call, close: () => appWs.client.close() };
}

/// `HH:MM` as minutes after midnight.
const minutes = (clock) => Number(clock.split(":")[0]) * 60 + Number(clock.split(":")[1]);

/// A store's full details, with `weeklyHours` for its schedule.
function storeDetails(ref, store, weeklyHours) {
  return {
    original_action: ref,
    description: "",
    cuisine_type: "",
    banner_data_uri: "",
    phone: "",
    address_street: "",
    address_city: "",
    address_state: "",
    address_zip: "",
    max_delivery_radius_km: 8,
    time_zone: SEED_TIME_ZONE,
    prep_minutes: 15,
    ...store.details,
    weekly_hours: weeklyHours,
  };
}

async function seedStore(store, owner, center) {
  const location = near(center, store.at);
  const ref = hash(await owner.call("catalog", "publish_catalog", { business_name: store.name, location, address_street: store.details.address_street ?? "" }));
  await owner.call("catalog", "update_catalog_details", storeDetails(ref, store, []));
  // Its choice groups, by key: each group's options numbered from 1.
  const groups = new Map();
  for (const group of store.groups ?? []) {
    const record = await owner.call("catalog", "create_modifier_group", {
      catalog_ref: ref,
      name: group.name,
      min_selections: group.min,
      max_selections: group.max,
      max_per_option: group.perOption ?? 1,
      free_selections: group.free ?? 0,
      options: group.options.map((o, i) => ({ id: i + 1, name: o.name, price_cents: o.price, available: true, nested_group: o.opens ? groups.get(o.opens) : null })),
    });
    groups.set(group.key, hash(record));
  }
  const items = new Map();
  for (const item of store.menu) {
    const record = await owner.call("catalog", "add_menu_item", {
      catalog_ref: ref,
      name: item.name,
      price_cents: item.price,
      available: true,
      description: item.description ?? "",
      photo_data_uri: "",
      category: item.category ?? "",
      dietary_tags: item.dietary_tags ?? [],
      modifier_groups: (item.groups ?? []).map((key) => groups.get(key)),
    });
    items.set(item.name, { ref: hash(record), price: item.price });
  }
  for (const promo of store.promos) {
    await owner.call("catalog", "create_promo_code", { catalog_ref: ref, code: promo.code, requirement: promo.requirement, reward: promo.reward, expires_at: null, auto_apply: promo.auto_apply ?? false });
  }
  if (store.goodieBag) {
    const start = now();
    await owner.call("catalog", "create_goodie_bag", {
      catalog_ref: ref,
      title: store.goodieBag.title,
      description: "Whatever's left from today's bake.",
      photo_data_uri: "",
      original_value_cents: store.goodieBag.original,
      price_cents: store.goodieBag.price,
      quantity_total: store.goodieBag.quantity,
      pickup_window_start: start,
      pickup_window_end: start + 6 * 3600 * 1_000_000,
      supports_pickup: true,
      supports_delivery: false,
      created_at: start,
    });
  }
  return { ...store, ref, owner, location, items };
}

/// One handoff of a delivery: the driver records it, the other party
/// acknowledges it -- what the driver's, store's and customer's screens do.
/// At the store, acknowledging checks the driver in, too.
async function attestLeg(driver, orderRef, sequence, kind, to, location) {
  const leg = hash(await eventually(`record ${kind}`, () => driver.call("attestation", "record_leg", { order_ref: orderRef, sequence, kind, to: to.key, geo_at_completion: location })));
  await eventually(`acknowledge ${kind}`, () => to.call("attestation", "acknowledge_leg", leg));
}

/// The deliveries each seeded driver has taken on so far.
const driverOrders = new Map();

const DELIVERY_STEPS = ["Placed", "Open", "BidPlaced", "BidAccepted", "MerchantConfirmed", "PickedUp", "Delivered"];
const PICKUP_STEPS = ["Placed", "MerchantConfirmed", "ReadyForPickup", "PickedUp"];
const reached = (steps, until, step) => steps.indexOf(until) >= steps.indexOf(step);

async function seedDelivery(order, customer, store, driver) {
  const items = order.items.map((name) => store.items.get(name));
  const dropoff = customer.home;
  const orderRef = hash(
    await eventually("request delivery", () =>
      customer.call("dispatch", "request_delivery", {
        merchant: store.owner.key,
        catalog_ref: store.ref,
        items: items.map((i) => ({ item_ref: i.ref, quantity: 1 })),
        order_total: items.reduce((sum, i) => sum + i.price, 0),
        dropoff,
        max_delivery_fee: 800,
        kitchen_notes: order.instructions ?? "",
        tip_cents: 300,
      }),
    ),
  );
  if (!reached(DELIVERY_STEPS, order.until, "Open")) return orderRef;
  await eventually("store accepts", () => store.owner.call("dispatch", "accept_delivery_order", { order_original_action: orderRef }));
  if (!reached(DELIVERY_STEPS, order.until, "BidPlaced")) return orderRef;
  const bidRef = hash(
    await eventually("submit bid", () =>
      driver.call("dispatch", "submit_bid", { order_ref: orderRef, eta_seconds: 1200, price_offer: 650 }),
    ),
  );
  if (!reached(DELIVERY_STEPS, order.until, "BidAccepted")) return orderRef;
  await eventually("accept bid", () => customer.call("dispatch", "accept_bid", { order_original_action: orderRef, bid_action: bidRef }));
  if (!reached(DELIVERY_STEPS, order.until, "MerchantConfirmed")) return orderRef;
  // The driver commits, then the store starts cooking. A delivery they
  // finished frees its place only once its money has settled, which their
  // app does in its own time: settled here first, and waited for.
  await eventually(
    "commit",
    async () => {
      for (const earlier of driverOrders.get(driver) ?? []) await driver.call("dispatch", "settle_order", earlier).catch(() => 0);
      await driver.call("dispatch", "commit_to_order", orderRef).catch((err) => {
        if (!/already committed/.test(String(err?.message ?? err))) throw err;
      });
    },
    240,
    500,
  );
  driverOrders.set(driver, [...(driverOrders.get(driver) ?? []), orderRef]);
  await stepOrDone("start cooking", () => store.owner.call("dispatch", "start_cooking", orderRef), /isn't waiting on the kitchen/);
  if (!reached(DELIVERY_STEPS, order.until, "PickedUp")) return orderRef;
  await attestLeg(driver, orderRef, 0, "MerchantHandoff", store.owner, store.location);
  await eventually("picked up", async () => {
    if ((await statusOf(driver, orderRef)) !== "PickedUp") await driver.call("dispatch", "pick_up_order", orderRef);
  });
  if (!reached(DELIVERY_STEPS, order.until, "Delivered")) return orderRef;
  await attestLeg(driver, orderRef, 1, "CustomerHandoff", customer, dropoff);
  await eventually("complete delivery", () => customer.call("dispatch", "complete_delivery", { order_original_action: orderRef }));
  if (order.review) {
    await eventually("review store", () => customer.call("reputation", "submit_review", { target: { Store: store.ref }, order_original_action: orderRef, rating: order.review.store, comment: order.review.comment }));
    await eventually("review driver", () => customer.call("reputation", "submit_review", { target: { Driver: driver.key }, order_original_action: orderRef, rating: order.review.driver, comment: "" }));
  }
  return orderRef;
}

async function seedPickup(order, customer, store) {
  const items = order.items.map((name) => store.items.get(name));
  const orderRef = hash(
    await eventually("request pickup", () =>
      customer.call("dispatch", "request_pickup_order", {
        merchant: store.owner.key,
        catalog_ref: store.ref,
        items: items.map((i) => ({ item_ref: i.ref, quantity: 1 })),
        order_total: items.reduce((sum, i) => sum + i.price, 0),
      }),
    ),
  );
  if (!reached(PICKUP_STEPS, order.until, "MerchantConfirmed")) return orderRef;
  await eventually("store accepts", () => store.owner.call("dispatch", "accept_pickup_order", { order_original_action: orderRef }));
  if (!reached(PICKUP_STEPS, order.until, "ReadyForPickup")) return orderRef;
  await eventually("mark ready", () => store.owner.call("dispatch", "mark_ready_for_pickup", orderRef));
  if (!reached(PICKUP_STEPS, order.until, "PickedUp")) return orderRef;
  await eventually("complete pickup", () => customer.call("dispatch", "complete_pickup", orderRef));
  if (order.review) {
    await eventually("review store", () => customer.call("reputation", "submit_review", { target: { Store: store.ref }, order_original_action: orderRef, rating: order.review.store, comment: order.review.comment }));
  }
  return orderRef;
}

async function main() {
  const center = parseCenter();
  const adminWs = await connectAdmin();
  const agents = [];
  try {
    const existing = (await adminWs.listApps({})).filter((app) => app.installed_app_id.startsWith(SEED_PREFIX));
    if (existing.length > 0) {
      console.log(`Already seeded (${existing.length} seed identities). Run \`npm run dev:reset\` to start over.`);
      return;
    }
    const happBytes = new Uint8Array(readFileSync(SERVED_HAPP));
    const appPort = await appInterfacePort(adminWs);

    console.log(`Seeding around ${center.lat.toFixed(4)}, ${center.lon.toFixed(4)}...`);
    // The issuer comes first: the network's properties name it, and every
    // identity -- seeded here or created in the app -- joins that network.
    const issuerKey = await adminWs.generateAgentPubKey();
    const network = { properties: { issuers: [encodeHashToBase64(issuerKey)] }, builtDna: dnaHashOf(DNA_PATH) };
    const issuer = await createAgent(adminWs, appPort, happBytes, { name: "Relay Credits" }, network, issuerKey, ISSUER_APP_ID);
    agents.push(issuer);
    network.dnaHash = encodeHashToBase64(issuer.cellId[0]);
    writeFileSync(DEV_NETWORK, `${JSON.stringify(network, null, 2)}\n`);
    await issuer.call("ledger", "set_issuer_profile", {
      name: "Relay Credits (dev)",
      description: "The dev network's issuer. Approve or decline cash-outs with `npm run issuer` in web/.",
      contact: "",
      payout_fee_cents: 25,
      payout_fee_basis_points: 25,
      min_payout_cents: dollars(5),
      payout_days: 1,
      recovery_wait_days: 7,
    });
    console.log("  ✓ Relay Credits, the network's issuer");

    const people = new Map();
    for (const person of WORLD.people) {
      const agent = await createAgent(adminWs, appPort, happBytes, person, network);
      agents.push(agent);
      await agent.call("profiles", "create_profile", { display_name: person.name, roles: person.roles, created_at: now(), bio: person.bio ?? "", phone: "", avatar_data_uri: "" });
      const addresses = (person.addresses ?? []).map((a) => ({ ...a, point: near(center, a.at) }));
      for (const address of addresses) {
        await agent.call("profiles", "save_address", { label: address.label, location: address.point, street: "", city: "", state: "", zip: "" });
      }
      agent.home = addresses[0]?.point ?? center;
      people.set(person.slug, agent);
      // Customers start with funds added through the issuer, as they would
      // by card.
      if (person.roles.includes("Requester")) {
        await issuer.call("ledger", "issue_grant", { to: agent.key, amount: dollars(100), reference: `seed-topup-${person.slug}` });
        await eventually(`${person.name} collecting their funds`, async () => {
          if ((await agent.call("ledger", "collect_grants", null)) === 0) throw new Error("not there yet");
        });
      }
      console.log(`  ✓ ${person.name} (${person.roles.join(", ")})`);
    }

    const stores = new Map();
    for (const store of WORLD.stores) {
      stores.set(store.key, await seedStore(store, people.get(store.owner), center));
      console.log(`  ✓ ${store.name} -- ${store.menu.length} menu items`);
    }

    for (const order of WORLD.orders) {
      const customer = people.get(order.customer);
      const store = stores.get(order.store);
      if (order.kind === "delivery") await seedDelivery(order, customer, store, people.get(order.driver));
      else await seedPickup(order, customer, store);
      console.log(`  ✓ ${order.kind} ${customer.name.split(" ")[0]} -> ${store.name}: ${order.until}`);
    }

    // Hours go on last: a store only takes orders while it's open, and the
    // seeded orders are placed now, whatever time it is.
    for (const store of stores.values()) {
      if (!store.hours) continue;
      const everyDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: minutes(store.hours.opens), closes: minutes(store.hours.closes) }));
      await store.owner.call("catalog", "update_catalog_details", storeDetails(store.ref, store, everyDay));
      console.log(`  ✓ ${store.name} -- open ${store.hours.opens}-${store.hours.closes} daily`);
    }

    // A driver who's cashed out some of their earnings, paid.
    const driver = people.get("dana");
    const earned = await driver.call("ledger", "get_balance", driver.key);
    if (earned >= dollars(5)) {
      const cashOut = await driver.call("ledger", "cash_out", { issuer: issuerKey, amount: dollars(5), instructions: "" });
      await eventually("the issuer paying Dana's cash-out", () => issuer.call("ledger", "decide_cash_out", { redemption: cashOut.redemption, outcome: { Paid: { reference: "po_seed_1" } } }));
      console.log("  ✓ Dana cashed out $5.00, paid");
    }

    console.log("\nSeeded. Sign in as anyone from the onboarding screen's \"Use an existing identity\" list.");
    console.log("Cash-outs wait for the issuer: `npm run issuer` lists them, and pays or declines them.");
  } finally {
    await Promise.all(agents.map((a) => a.close().catch(() => {})));
    await adminWs.client.close();
  }
}

main().catch((err) => {
  console.error(`\n✗ Seeding failed: ${err.message ?? err}`);
  process.exit(1);
});
