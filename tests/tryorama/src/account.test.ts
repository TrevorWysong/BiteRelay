// Proves recovering an account whose key was lost, onto a new key: by the
// recovery phrase's signature, or by enough guardians -- each checked
// against the account's own latest plan. (Moving to a new phone keeps the
// key: device-move.test.ts.) Forgeries are written raw (test-utils), as a
// modified client would.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import { agentAsLinkBase, phraseKey, phraseMessage, retryUntil, retryUntilOk, setupPlayersWithProperties, useTestCoordinators } from "./helpers.js";

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
  kind: "Phrase" | "Guardians";
}

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
  await assert.rejects(
    account(erin)("create_raw_succession_for_testing", { predecessor: carol.agentPubKey, authority: { Phrase: { plan: firstPlan.plan, head, signature: phrase.sign(phraseMessage(carol.agentPubKey, erin.agentPubKey, head!)) } } }),
    /one account/,
    "even forged",
  );
  assert.equal(await balance(erin), 0, "a recovered account's money isn't moved on the phrase's word");
  await sync();
  const moved = await retryUntil(() => account(carol)<SuccessionView[]>("successions_of", dana.agentPubKey), (list) => list.length === 1);
  assert.ok(same(moved[0].successor, erin.agentPubKey) && moved[0].kind === "Phrase", "everyone sees Dana's account recovered onto Erin's key");
  const line = await account(carol)<Uint8Array[]>("lineage", erin.agentPubKey);
  assert.ok(line.length === 1 && same(line[0], dana.agentPubKey), "and Erin's key carries Dana's history");
  const since = (who: typeof alice) => account(carol)<number | null>("account_since", who.agentPubKey);
  assert.equal(await since(erin), await since(dana), "and her account's age: a recovery doesn't make it new");
  console.log("[PASS] the recovery phrase's signature, for this key and this account, recovers it");

  // An issuer reissues it -- asked only by the recovering key.
  await account(erin)("request_reissue", issuer.agentPubKey);
  await sync();
  const reissue = await retryUntil(() => account(issuer)<{ requests: { predecessor: Uint8Array; successor: Uint8Array }[] }>("get_reissue_requests", { after: null }).then((p) => p.requests), (r) => r.length === 1);
  assert.ok(same(reissue[0].predecessor, dana.agentPubKey) && same(reissue[0].successor, erin.agentPubKey));
  const standing = await ledger(issuer)<{ balance: number }>("standing_at", { agent: dana.agentPubKey, head });
  assert.deepEqual(standing, { balance: 2500 }, "where the account's ledger stood");
  await assert.rejects(account(bob)("request_reissue", issuer.agentPubKey), /hasn't recovered an account/, "only a recovering key asks");
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
