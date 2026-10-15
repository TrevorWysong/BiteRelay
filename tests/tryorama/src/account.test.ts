// Proves carrying an account on to a new key: handed over by the old device
// (its ledger closes, its balance moves once, to the key it names), or
// recovered when it's lost -- by the recovery phrase's signature, or by
// enough guardians -- each checked against the account's own latest plan.
// Forgeries are written raw (test-utils), as a modified client would.
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import { dhtLocationFrom32 } from "@holochain/client";
import { EMPTY_HANDS, agentAsLinkBase, latestLedgerEntry, retryUntil, retryUntilOk, setupPlayersWithProperties, useTestCoordinators } from "./helpers.js";

interface PlanView {
  plan: Uint8Array;
  account: Uint8Array;
  phrase_key: Uint8Array | null;
  guardians: Uint8Array[];
  threshold: number;
}
interface SuccessionView {
  succession: Uint8Array;
  predecessor: Uint8Array;
  successor: Uint8Array;
  kind: "HandOver" | "Phrase" | "Guardians";
}

/// A recovery phrase's key, as the app derives one: an Ed25519 key in the
/// form Holochain carries agent keys (a 3-byte prefix, 32 bytes, 4 of
/// location).
function phraseKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const key = new Uint8Array([0x84, 0x20, 0x24, ...raw, ...dhtLocationFrom32(raw)]);
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return { key, sign: (message: Uint8Array) => new Uint8Array(sign(null, message, createPrivateKey({ key: der, format: "der", type: "pkcs8" }))) };
}

/// What a phrase's key signs -- `account_types::phrase_message`.
const phraseMessage = (predecessor: Uint8Array, successor: Uint8Array, head: Uint8Array) =>
  new Uint8Array([...new TextEncoder().encode("relay-recovery:v1:"), ...predecessor, 58, ...successor, 58, ...head]);

const same = (a: Uint8Array | null | undefined, b: Uint8Array) => !!a && Buffer.from(a).equals(Buffer.from(b));

await runScenario(async (scenario) => {
  const [issuer, alice, bob, carol, dana, erin, hank] = await setupPlayersWithProperties(scenario, 7, (keys) => ({ issuers: [keys[0]], credit_limit_cents: 0 }));
  const all = [issuer, alice, bob, carol, dana, erin, hank];
  for (const p of all) await useTestCoordinators(p, ["account", "ledger"]);
  const sync = () => dhtSync(all, alice.cells[0].cell_id[0]);
  const account = (p: typeof alice) => getZomeCaller(p.cells[0], "account");
  const ledger = (p: typeof alice) => getZomeCaller(p.cells[0], "ledger");
  const balance = (p: typeof alice) => ledger(p)<number>("get_balance", p.agentPubKey);
  const fund = async (p: typeof alice, amount: number, reference: string) => {
    await ledger(issuer)("issue_grant", { to: p.agentPubKey, amount, reference });
    await sync();
    await retryUntilOk(() => ledger(p)<number>("collect_grants", null).then((n) => (n > 0 ? n : Promise.reject(new Error("not yet")))));
  };

  // ===== A plan is the account's own, and sound =====
  const rawPlan = (p: typeof alice, plan: unknown) => account(p)("create_raw_plan_for_testing", plan);
  const guardians = [bob.agentPubKey, carol.agentPubKey, issuer.agentPubKey];
  await assert.rejects(rawPlan(dana, { phrase_key: null, guardians: [dana.agentPubKey], threshold: 1 }), /a guardian is someone else/);
  await assert.rejects(rawPlan(dana, { phrase_key: null, guardians: [bob.agentPubKey, bob.agentPubKey], threshold: 1 }), /each guardian once/);
  await assert.rejects(rawPlan(dana, { phrase_key: null, guardians, threshold: 4 }), /between one and all/);
  await assert.rejects(rawPlan(dana, { phrase_key: null, guardians, threshold: 0 }), /between one and all/);
  await assert.rejects(rawPlan(dana, { phrase_key: null, guardians: [], threshold: 1 }), /needs no vouches/);
  await assert.rejects(rawPlan(dana, { phrase_key: dana.agentPubKey, guardians: [], threshold: 0 }), /its own, not the account's/);
  console.log("[PASS] a recovery plan names others, each once, with a sensible threshold");

  // ===== Moving to a new device: Alice hands over to Bob's key =====
  await fund(alice, 3000, "alice-1");
  await assert.rejects(account(alice)("hand_over", { successor: alice.agentPubKey, parcel: "" }), /this device's own key/);
  const bequest = await account(alice)<Uint8Array>("hand_over", { successor: bob.agentPubKey, parcel: JSON.stringify({ name: "Alice", phone: "+44 20 7946 0000" }) });
  assert.equal(await balance(alice), 0, "the whole balance goes");
  await assert.rejects(ledger(alice)("cash_out", { issuer: issuer.agentPubKey, amount: 1000, instructions: "" }), /moved to a new device/, "the old key can't spend");
  const latest = await latestLedgerEntry(alice);
  await assert.rejects(
    ledger(alice)("create_raw_ledger_entry_for_testing", { kind: { Inherit: { bequest } }, amount: 3000, balance: 3000, in_hand: EMPTY_HANDS, previous: latest.hash }),
    /ledger is closed/,
    "nor can a modified app write after the hand-over",
  );
  await fund(carol, 1000, "carol-1");
  const carolLatest = await latestLedgerEntry(carol);
  await assert.rejects(
    ledger(carol)("create_raw_ledger_entry_for_testing", { kind: { HandOver: { successor: dana.agentPubKey } }, amount: 400, balance: 600, in_hand: EMPTY_HANDS, previous: carolLatest.hash }),
    /whole balance/,
    "a hand-over takes everything, or nothing",
  );
  console.log("[PASS] a hand-over passes on the whole balance, and closes the old key's ledger");

  await sync();
  const [found] = await retryUntil(() => ledger(bob)<{ bequest: Uint8Array; amount: number }[]>("bequests_to_me", null), (list) => list.length === 1);
  assert.equal(found.amount, 3000);
  await assert.rejects(account(carol)("take_over", { predecessor: alice.agentPubKey, authority: { HandOver: { bequest } } }), /to the key it names/, "only the key it names takes it over");
  await account(bob)("take_over", { predecessor: alice.agentPubKey, authority: { HandOver: { bequest } } });
  assert.equal(await balance(bob), 3000, "the balance comes with it");
  const bobLatest = await latestLedgerEntry(bob);
  await assert.rejects(
    ledger(bob)("create_raw_ledger_entry_for_testing", { kind: { Inherit: { bequest } }, amount: 3000, balance: 6000, in_hand: EMPTY_HANDS, previous: bobLatest.hash }),
    /taken in once/,
    "once",
  );
  assert.deepEqual(await account(bob)<string[]>("open_parcels", null), [JSON.stringify({ name: "Alice", phone: "+44 20 7946 0000" })], "what only Alice could read, Bob now can");
  assert.deepEqual(await account(carol)<string[]>("open_parcels", null), [], "and nobody else");
  await sync();
  const moved = await retryUntil(() => account(carol)<SuccessionView[]>("successions_of", alice.agentPubKey), (list) => list.length === 1);
  assert.ok(same(moved[0].successor, bob.agentPubKey) && moved[0].kind === "HandOver", "everyone sees Alice's account moved to Bob");
  const line = await account(carol)<Uint8Array[]>("lineage", bob.agentPubKey);
  assert.ok(line.length === 1 && same(line[0], alice.agentPubKey), "and Bob's account carries Alice's history");
  const since = (who: typeof alice) => account(carol)<number | null>("account_since", who.agentPubKey);
  assert.equal(await since(bob), await since(alice), "and her account's age: a new phone doesn't make it new");
  console.log("[PASS] the new key takes the account over once, with its balance and sealed details");

  // ===== Recovery by phrase =====
  const phrase = phraseKey();
  await fund(dana, 2500, "dana-1");
  const firstPlan = await account(dana)<PlanView>("set_recovery_plan", { phrase_key: phrase.key, guardians, threshold: 2 });
  await sync();
  const accounts = await retryUntil(() => account(erin)<PlanView[]>("accounts_for_phrase_key", phrase.key), (list) => list.length === 1);
  assert.ok(same(accounts[0].account, dana.agentPubKey), "the phrase finds the account it recovers");
  const head = await retryUntil(() => account(erin)<Uint8Array | null>("latest_action_of", dana.agentPubKey), (h) => !!h);
  const viaPhrase = (signature: Uint8Array, plan = firstPlan.plan, at = head!) => ({ predecessor: dana.agentPubKey, authority: { Phrase: { plan, head: at, signature } } });

  await assert.rejects(account(erin)("take_over", viaPhrase(phrase.sign(phraseMessage(dana.agentPubKey, hank.agentPubKey, head!)))), /recovery phrase's signature/, "a signature for another key");
  await assert.rejects(account(erin)("take_over", viaPhrase(phraseKey().sign(phraseMessage(dana.agentPubKey, erin.agentPubKey, head!)))), /recovery phrase's signature/, "another phrase's signature");
  const carolHead = await retryUntil(() => account(erin)<Uint8Array | null>("latest_action_of", carol.agentPubKey), (h) => !!h);
  await assert.rejects(account(erin)("take_over", viaPhrase(phrase.sign(phraseMessage(dana.agentPubKey, erin.agentPubKey, carolHead!)), firstPlan.plan, carolHead!)), /its own chain/, "where the account stood is on its chain");

  await account(erin)("take_over", viaPhrase(phrase.sign(phraseMessage(dana.agentPubKey, erin.agentPubKey, head!))));
  await assert.rejects(account(erin)("take_over", viaPhrase(phrase.sign(phraseMessage(dana.agentPubKey, erin.agentPubKey, head!)))), /already taken over/, "a key takes over one account");
  await assert.rejects(account(erin)("create_raw_succession_for_testing", { predecessor: carol.agentPubKey, authority: { HandOver: { bequest } } }), /one account/, "even forged");
  assert.equal(await balance(erin), 0, "a recovered account's money isn't moved on the phrase's word");
  console.log("[PASS] the recovery phrase's signature, for this key and this account, recovers it");

  // An issuer reissues it -- asked only by the recovering key.
  await account(erin)("request_reissue", issuer.agentPubKey);
  await sync();
  const reissue = await retryUntil(() => account(issuer)<{ requests: { predecessor: Uint8Array; successor: Uint8Array }[] }>("get_reissue_requests", { after: null }).then((p) => p.requests), (r) => r.length === 1);
  assert.ok(same(reissue[0].predecessor, dana.agentPubKey) && same(reissue[0].successor, erin.agentPubKey));
  const standing = await ledger(issuer)<{ balance: number; handed_over: boolean }>("standing_at", { agent: dana.agentPubKey, head });
  assert.deepEqual(standing, { balance: 2500, handed_over: false }, "where the account's ledger stood");
  await assert.rejects(account(bob)("request_reissue", issuer.agentPubKey), /brings its balance with it/, "a hand-over isn't reissued");
  await assert.rejects(account(erin)("test_create_link", { link_type: "IssuerToReissue", base: agentAsLinkBase(carol.agentPubKey), target: (await account(erin)<SuccessionView>("my_succession", null)).succession }), /issuer on the roster/, "only an issuer reissues");
  console.log("[PASS] a recovered account asks an issuer to reissue its balance");

  // ===== Recovery by guardians =====
  await assert.rejects(account(alice)("vouch", { account: dana.agentPubKey, successor: hank.agentPubKey }), /aren't one of this account's guardians/);
  await assert.rejects(account(alice)("create_raw_vouch_for_testing", { account: dana.agentPubKey, successor: hank.agentPubKey, plan: firstPlan.plan }), /only a guardian/, "nor forged");
  const wards = await retryUntil(() => account(bob)<PlanView[]>("my_wards", null), (list) => list.length === 1);
  assert.ok(same(wards[0].account, dana.agentPubKey), "a guardian sees who they guard");
  const bobVouch = await account(bob)<Uint8Array>("vouch", { account: dana.agentPubKey, successor: hank.agentPubKey });
  assert.deepEqual(await account(bob)("vouch", { account: dana.agentPubKey, successor: hank.agentPubKey }), bobVouch, "safe to repeat");
  await assert.rejects(account(bob)("vouch", { account: dana.agentPubKey, successor: carol.agentPubKey }), /already vouched for another key/);
  await assert.rejects(account(bob)("create_raw_vouch_for_testing", { account: dana.agentPubKey, successor: carol.agentPubKey, plan: firstPlan.plan }), /once for each account and plan/, "once, even forged");
  await sync();
  const viaGuardians = (vouches: Uint8Array[]) => ({ predecessor: dana.agentPubKey, authority: { Guardians: { plan: firstPlan.plan, head, vouches } } });
  await assert.rejects(account(hank)("take_over", viaGuardians([bobVouch])), /not enough guardians/, "one of two isn't enough");
  await assert.rejects(account(hank)("take_over", viaGuardians([bobVouch, bobVouch])), /counts once/, "nor the same one twice");
  const carolVouch = await account(carol)<Uint8Array>("vouch", { account: dana.agentPubKey, successor: hank.agentPubKey });
  await sync();
  const vouches = await retryUntil(() => account(hank)<unknown[]>("vouches_for_me", null), (list) => list.length === 2);
  assert.equal(vouches.length, 2);
  await account(hank)("take_over", viaGuardians([bobVouch, carolVouch]));
  console.log("[PASS] enough of an account's guardians, each once, recover it");

  // ===== Only the account's latest plan counts =====
  const newPhrase = phraseKey();
  await account(dana)("set_recovery_plan", { phrase_key: newPhrase.key, guardians: [], threshold: 0 });
  await sync();
  const newHead = await retryUntil(() => account(carol)<Uint8Array | null>("latest_action_of", dana.agentPubKey), (h) => !!h && !same(h, head!));
  await assert.rejects(
    account(carol)("take_over", { predecessor: dana.agentPubKey, authority: { Phrase: { plan: firstPlan.plan, head: newHead, signature: phrase.sign(phraseMessage(dana.agentPubKey, carol.agentPubKey, newHead!)) } } }),
    /latest recovery plan/,
    "a phrase the account replaced recovers nothing",
  );
  assert.equal((await account(carol)<PlanView[]>("accounts_for_phrase_key", phrase.key)).length, 0, "nor finds it");
  // Validation can only check the plan was current where the recovery says
  // the account stood -- an old point, here, before the phrase was
  // replaced. It accepts that; nobody counts it.
  await account(carol)("take_over", { predecessor: dana.agentPubKey, authority: { Phrase: { plan: firstPlan.plan, head, signature: phrase.sign(phraseMessage(dana.agentPubKey, carol.agentPubKey, head!)) } } });
  await sync();
  assert.deepEqual(await account(alice)<SuccessionView[]>("successions_of", dana.agentPubKey), [], "every recovery that rested on the replaced plan is void");
  assert.deepEqual(await account(alice)<Uint8Array[]>("lineage", carol.agentPubKey), [], "and carries no history");
  console.log("[PASS] a replaced plan no longer counts");
});
