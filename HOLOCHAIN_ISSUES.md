# Holochain Issues Found During Development

Versions in use: `holochain 0.7.0`, `hdk 0.7.0`, `hdi 0.8.0`, `kitsune2 0.5.0`,
`kitsune2_transport_iroh 0.5.0`, `holochain_p2p 0.7.0` (upgraded 2026-09-28
from `0.6.3`/`0.6.3`/`0.7.3`/`0.4.1`/`0.4.1`/`0.6.3` — see the architecture
plan's §0 for the full upgrade writeup, including what did and didn't need
to change). Sections below were written against the older versions; each
has been re-checked against 0.7.0 and annotated where anything changed.

These are things found in Holochain itself (or its immediate dependencies)
while building this project — not bugs in this project's own zome code.
Each was found by reading the actual vendored source in
`~/.cargo/registry/src/index.crates.io-*/`, not assumed from documentation,
and (where noted) confirmed empirically against a real running conductor.
Holochain is pre-1.0 and moves fast; these are accurate as of the versions
above and may already be fixed in later releases.

**Not all of these are "Holochain bugs."** Each section below is tagged with
one of four classifications, applied after deliberately re-checking every
one against the actual data rather than trusting the first plausible
explanation found:

- **Bug / real inconsistency** — behavior that contradicts the crate's own
  stated intent or a sibling code path's own handling of the same case.
- **Intended design, easy to misread** — Holochain is doing exactly what it
  means to do; the gap is that the behavior isn't obvious from the API
  surface, so it's easy for app code (including this project's, initially)
  to assume the wrong thing.
- **Correct-by-design, we needed to adapt our architecture** — not a gap in
  Holochain at all; a case where our own mental model was wrong and the fix
  belongs entirely on our side.
- **Acknowledged incomplete feature** — openly known by the Holochain team
  as unfinished, not something we discovered.

One entry (#1) was re-opened after the first version of this document
overclaimed a specific root cause. Direct testing (querying each
conductor's own peer store contents, and checking whether an agent's
network URL is per-agent or per-conductor) ruled out the mechanism
originally cited. The corrected version below says plainly what's still
confirmed, what was retracted, and what remains genuinely unknown —
worth reading if you only read one section closely, since it's the
clearest example of the difference between "a plausible line of code" and
"the actual, checked cause."

---

## 1. Signal delivery caps at roughly one recipient per destination conductor process when many agents are co-located — exact mechanism not fully confirmed

**Classification:** Bug or intended-but-undocumented limitation — genuinely
unresolved which, pending upstream confirmation. **Not** "our architecture,"
per the evidence below — the effect tracks conductor-process topology, not
anything this project's zome code or test design controls.

**Component:** somewhere in `holochain_p2p 0.6.3` / `kitsune2 0.4.1`'s
handling of an incoming remote-signal targeting multiple locally-hosted
cells on one conductor. **The specific line originally cited here has been
retracted** — see "What was claimed, and what actually happened" below.
This is being left in with the correction visible, rather than quietly
fixed, because the correction is more informative than the original claim.

**What we observed, confirmed across multiple runs:** a signal fan-out to a
pool of co-located driver agents delivers to almost exactly one agent per
*destination conductor process*, regardless of how many agents that
conductor hosts. Three runs of a 3-conductor x 12-agent topology delivered
to driver indices `[3,12,26]`, `[2,21,30]`, `[5,19,25]` — mapped against
conductor ownership, every run hit exactly one driver per conductor, never
two from the same one, never zero from one. A 5x7 topology (same 35-agent
total) delivered to 4 of 5 conductors. An 8x1 topology (no co-location at
all — every agent on its own conductor) delivered 7 of 7, 100%. We ruled out
CPU contention (identical delivery count under artificial 8-core
saturation) and slow sequential signing (delivery didn't improve with a
60-second observation window instead of 8; all successful deliveries
arrived within ~220ms of each other every time, nothing ever trickled in
later) before looking at the transport/dispatch code at all.

**What was claimed, and what actually happened:** the first version of this
document pointed at `holochain_p2p`'s `send_remote_signal` fan-out loop,
which does silently `continue` past a recipient if
`peer_store().get(to_agent_id)` returns no resolved URL — a real code path,
confirmed by reading the source, that *could* cause exactly this kind of
drop. But two follow-up checks, run specifically because this document was
being reviewed for overclaiming, contradict it as the actual explanation
here:
- Querying each conductor's own peer store directly
  (`adminWs().agentInfo({ dna_hashes: null })`) showed **all 36 agents
  present on every conductor**, not a partial or missing set — so the
  lookup this line performs should be finding an entry for every recipient,
  not hitting the `None` branch at the rate we're seeing.
- The candidate agent's URL is not actually per-agent at all —
  `kitsune2_transport_iroh`'s `IrohTransport` holds exactly one
  `local_url: Arc<RwLock<Option<Url>>>` for the *whole conductor process*,
  shared by every agent hosted on it. If URL resolution were the bottleneck,
  every agent on a given conductor should succeed or fail *together* (they
  all report the identical URL value) — not exactly one out of eleven.

Both checks point the same way: the sender-side peer-store lookup is very
likely not where this actually happens. The real mechanism is more likely
on the *receiving* conductor's side — something about how one incoming
connection carrying messages for several different locally-hosted cells
gets routed to each cell's own zome-call execution — but we have not traced
that code path to a specific line. It would mean reading a different,
larger part of `holochain_p2p`'s cell-dispatch handling that we haven't
opened yet, and doing that live-instrumentation-free from source alone may
not even be enough to settle it.

**Re-checked against 0.7.0 (2026-09-28):** not re-run empirically — doing so
would mean repeating the full `load-test.ts` multi-conductor investigation
from §10 of the architecture plan, which wasn't warranted just for a version
bump. Checked what *can* be checked without a live run: the 0.7.0 changelog
range (0.6.3→0.7.0) doesn't mention any change to signal fan-out, remote-signal
dispatch, or per-conductor connection handling — the closest related item is
tx5's removal (already irrelevant here, since Iroh was already this project's
sole transport as of 0.6.3) and cell-startup concurrency limiting (a different
code path, startup not steady-state signaling). Absent a changelog signal and
absent a re-run, treat this finding as still open and unverified against
0.7.0, not as fixed or regressed.

**Why it matters regardless of the exact line:** the *symptom* is real and
reproducible, independent of which line causes it. It specifically affects
**Holo Host-style multi-tenancy** (few host machines, each running one
conductor process for many hosted end-user identities) — a pattern
Holochain's own architecture supports and Holo Host is explicitly built on,
not a misuse of the API. With one agent per conductor (the normal
"one person, one device" model most of the ecosystem runs), delivery was
clean at 100%. Any app that relies on `send_remote_signal` reaching a
specific count or fraction of a co-located recipient pool will see this
exact failure mode under hosted multi-tenancy, silently, with nothing to
catch or log.

**Fix / workaround:**
- **Practical workaround used in this project, which fully covers it:**
  never treat `send_remote_signal` as a delivery guarantee for *any*
  recipient count, co-located or not. Pair every signal-based fast path
  with an independent, DHT-backed polling read that a receiver checks on
  its own cadence regardless of whether a signal arrived. This project's
  `dispatch`/`geo_presence` zomes already do this by design — which is why
  this issue never caused a correctness problem in this project's own
  tests, only a UX/latency cost specifically under the co-located-agent
  topology.
- **If you want the actual root cause pinned down:** the next real step is
  live tracing (not source reading) in a custom-built `holochain` binary
  with logging added to the receiving conductor's incoming-message
  dispatch path, watching what happens to the messages that don't get
  delivered. That's a meaningfully bigger undertaking than what produced
  this document, and wasn't done here.
- Worth filing as a question with the Holochain team either way — "does
  signal fan-out to many co-located agents on one destination conductor
  have a known limit, and if so where" — since even if the answer is
  "known and intended," it doesn't currently appear to be documented
  anywhere we found.

---

## 2. `update_entry`/`create_entry` validation is deferred to commit time — nested zome calls are not part of the same atomic commit

**Classification:** Intended design, easy to misread. Re-checked directly
against the question "is this actually correct Holochain behavior, or a
bug" — it's correct: self-validation genuinely can't run any earlier than
commit time, and a nested `call()` genuinely is a separate zome invocation
with its own independent commit. Nothing here contradicts Holochain's own
design; the gap is purely that this consequence isn't obvious from the
`update_entry`/`call()` API surface, and is easy to get wrong even while
writing careful code — which is what happened in this project before it was
caught.

**Component:** `hdk 0.6.3` / `holochain 0.6.3` conductor commit path (general
behavior, not one specific file)

**Re-checked against 0.7.0 (2026-09-28):** still applies, unchanged. This is
not a version-specific bug to begin with — deferred self-validation at
commit time, and nested `call()`s committing independently, are fundamental
properties of Holochain's execution model that the FlatOp/TypedAction API
redesign (§0 of the architecture plan) didn't touch. Confirmed concretely,
not just by inference: this exact footgun was independently rediscovered one
day before this upgrade, in `apply_cancellation_dispute_resolution`
(architecture plan §11.1, built and debugged 2026-09-27, still on 0.6.3) —
and nothing in the 0.7.0 commit-path changes (self-validation timing, nested
zome-call independence) gives any reason to expect that finding stopped
applying after the version bump; it's an execution-model property, not a
patched code path.

**Observed on 0.7.0 (2026-10):** the *other* direction propagates too. A
same-cell nested `call()` whose own write failed validation (a reputation
event with subject == counterparty, from a merchant ordering at their own
store) failed the *outer* call's commit, with the nested write's validation
error -- even though the outer function discarded the nested result with
`let _ = call(...)`. So `let _` does not make a nested side effect
best-effort: anything a nested call would write must be pre-checked the same
way as the outer function's own writes (here: `record_reputation_event` now
skips subject == caller before calling). Not re-verified on 0.7.0: whether a
nested write that *passes* validation still lands when the outer commit is
rejected (the 0.6.3 behavior described below) -- keep treating it as if it
does, since the pre-check-everything fix covers both cases.

**Description:** Calling `update_entry`/`create_entry` inside a coordinator
extern does not synchronously validate. It stages the write; self-validation
only runs when the *whole* extern function returns and the conductor commits
every staged write from that call together. Code written *after* an
`update_entry(...)?` call in the same function keeps executing even when
that eventual commit is destined to be rejected. Critically, a nested
`call()` to a *different* zome (e.g. calling `ledger::forfeit` or
`reputation::record_event` from within an order-update coordinator function)
is a fully separate, independent zome invocation with its own commit cycle —
it commits immediately and for real, completely unaffected by whatever the
outer function's own commit later decides.

Concretely, in this project: a coordinator function did
`update_entry(...)?` first (intending "if this fails, nothing below it
should have any effect"), then conditionally called into `ledger` and
unconditionally into `reputation` afterward. An **unauthorized caller**
(not an arbitrator) invoked this function; the outer `update_entry` was
correctly rejected at commit time — but by then the nested
`reputation::record_event` call had already executed and committed for
real. The caller's call *did* error (so a naive `assert.rejects` test
passes), but a real, permanent side effect had already landed despite the
call "failing."

**Why it matters:** This is a genuine, easy-to-miss correctness/security
footgun for *any* Holochain app that combines "gate an update, then act on
side effects in the same function" — which is an extremely natural pattern
to reach for. It means:
- An unauthorized caller can trigger real side effects (reputation events,
  and — if they happen to be a party to the underlying transaction per that
  zome's own authorization rule — real payments) even though the call they
  made ultimately "failed" and returned an error.
- A test that only checks "did the call return an error" (rather than
  independently checking for leaked side effects) will pass while missing
  this exact bug — which is exactly what happened during development here;
  the bug was only caught because a *different* test's reputation-count
  assertion came out wrong, not because any authorization test failed to
  reject the call it was checking.
- This is systemic wherever the pattern repeats, not a one-off: a second,
  structurally identical function in the same codebase (already shipped,
  already "tested") had the identical exposure and had simply never been
  hit by a test that used a real unauthorized caller against the real
  function, rather than an isolated bypass extern with no nested calls.

**Fix / workaround:**
- No upstream fix needed/expected here — this is Holochain's actual, correct
  execution model (self-commit-time validation, independent nested zome
  calls); the issue is that it's easy to *assume* otherwise and not obvious
  from the API surface alone.
- **The fix is at the application level, and is the one this project
  applied:** never rely on an `update_entry`'s own eventual, deferred
  validation to protect against a caller's bad input. Perform *all*
  authorization and replay/already-applied checks explicitly, synchronously,
  as plain `if` statements at the very top of the function — before any
  `update_entry` call and before any nested `call()` to another zome. The
  deferred `validate()` check can still remain as network-wide
  defense-in-depth (it catches a peer running a modified coordinator that
  skips the app-level check entirely), but the honest coordinator itself
  must not depend on its own later failure to protect its own side effects.
- Worth Holochain documenting explicitly (in the `update_entry`/`create_entry`
  API docs and any "how to structure a coordinator function safely" guide):
  that nested `call()`s are not covered by the calling function's own
  eventual commit-time validation outcome, since this is the kind of thing
  that reads as "obviously fine" until it demonstrably isn't.

---

## 3. `LinkQuery.after`/`.before` are inclusive (`>=`/`<=`), not exclusive

**Classification:** Underdocumented, not a violated contract — re-checked
the actual doc comment on the field before calling this a "bug," since that
distinction matters. It reads: `/// Only include links created after this
time.` That's genuinely ambiguous in plain English; it doesn't claim
strictly-greater-than anywhere, and `>=` is a defensible reading of it.
This is us having assumed a stricter meaning than what's actually promised,
not Holochain contradicting its own documentation. It stays in this
document because the *practical effect* — silent off-by-one duplication —
is real and worth flagging, even though "bug" isn't the right word for it.

**Component:** `holochain_state 0.6.3`, `src/query/link.rs`

**Re-checked against 0.7.0 (2026-09-28), confirmed directly from source, not
assumed:** the exact filter logic lives in `holochain_state-0.7.0/src/
dht_store/reads.rs`, applied as `if timestamp < after { continue }` /
`if timestamp > before { continue }` — i.e. still keeps (includes) anything
`>= after` and `<= before`, byte-for-byte the same inclusive semantics as
0.6.3. Unchanged by this upgrade; the workarounds below still apply as-is.

**Description:** `LinkQuery.after: Option<Timestamp>` compiles to SQL `>=`
against the link's timestamp, not `>`. The same applies to `.before`
(`<=`). This is easy to assume is exclusive by analogy with typical
"cursor pagination" APIs, where "give me items after X" conventionally
means strictly greater than X.

**Why it matters:** Caused two real bugs in this project before the actual
SQL was checked directly:
- **Double-counting in checkpoint math:** a checkpoint entry's own
  underlying transaction/event would come back again in a subsequent
  "everything since the checkpoint" query (`after: checkpoint.recorded_at`),
  since that exact timestamp satisfies `>=`, double-counting it.
- **Pagination boundary duplication:** naively passing a page's last item's
  timestamp back as the next page's `after` cursor returns that same
  boundary item twice, for the same reason.

Any Holochain app that paginates via `LinkQuery.after`/`.before`, or that
computes "everything since a checkpoint" via the same mechanism, will hit
this exact off-by-one unless it's specifically accounted for.

**Fix / workaround:**
- For an exact, correctness-critical case (this project's ledger/reputation
  checkpoint math): don't rely on timestamp semantics at all — exclude the
  specific already-counted hash explicitly, since equal timestamps can't be
  disambiguated by the query alone.
- For a "browse more" pagination UI (lower stakes, not correctness-critical):
  nudge the cursor forward by the smallest representable unit
  (one microsecond, for a `Timestamp`) before using it as the next page's
  `after` value. This has a named, accepted caveat: two links sharing the
  *exact* same microsecond timestamp aren't disambiguated by this fix either
  — acceptable for a UI browse read, not for anything requiring an exact
  count.
- Worth Holochain either renaming these fields to make the inclusivity
  explicit (`after_or_equal`/`before_or_equal`), or exposing an exclusive
  variant alongside the inclusive one, since the inclusive behavior is the
  less commonly *wanted* one for typical pagination use.

---

## 4. `get()` on an `ActionHash` never resolves to "the latest update" — only `EntryHash`-based gets do

**Classification:** Correct-by-design — this is arguably the clearest case
in this whole document of "our architecture's mental model was wrong, not
Holochain." An `ActionHash` is a content-address for one specific,
immutable action; having `get()` return anything *other* than that literal
action for an `ActionHash` would break a much more fundamental guarantee
(content-addressing) than it would fix. `EntryHash` is different by nature,
not by inconsistency — many actions can legitimately update the same entry,
so "the current one" is a meaningful question for an `EntryHash` in a way
it structurally isn't for an `ActionHash`. We're keeping this in the
document because the trap is real and cost real debugging time, but it
would be inaccurate to call it a Holochain gap — the fix is entirely a
"design your coordinator functions around this" problem, not an "upstream
should change something" one.

**Component:** `hdk 0.6.3`, general `get`/`get_details` behavior

**Re-checked against 0.7.0 (2026-09-28):** still applies, unchanged — this
is content-addressing, not an API detail the FlatOp/TypedAction redesign
touched. `hdk 0.7.0`'s `get()`/`get_details()` signatures over an
`ActionHash` are otherwise identical; the `resolve_latest()` workaround
pattern below needs no changes and continues to be used as-is throughout
this codebase post-upgrade.

**Description:** Calling `get()` (or `get_details()`) on an `ActionHash`
is completely literal — it returns the record at exactly that action,
never automatically walking forward through any chain of updates to that
entry. That auto-resolution to "latest" only happens when querying by
*`EntryHash`* instead. This is a genuinely easy assumption to get backwards,
since "get the latest state of this thing" is usually what a caller
actually wants, and nothing in the `get()` call site signals which behavior
you're going to get based on the hash type alone.

**Why it matters:** Every coordinator function in this project that did
get-then-update on a repeatedly-updated entry (accepting a bid, changing an
order's status, completing a delivery, opening/closing a catalog, updating
a profile — plus every list/browse read that could show a stale status) was
silently reading and updating from the entry's *original creation action*
every time, rather than its current state. A chain of legitimate updates
like `Open → BidAccepted → MerchantConfirmed → …` would validate as
`Open → MerchantConfirmed` (skipping the intermediate state) and fail,
because the "prior state" being read was always the very first version, not
the one immediately before the new update.

This is a very likely trap for any Holochain app with entries that get
updated more than once over their lifetime — which is most non-trivial
app state.

**Fix / workaround:**
- Add a small `resolve_latest(original_action_hash)` helper: call
  `get_details()`, then recursively walk the `.updates` field by max
  timestamp to find the actual current record. Use this everywhere a
  coordinator function needs "the current state," while still letting
  external callers pass one *stable* reference (an entry's original
  creation hash) across repeated updates, rather than requiring every
  caller to track the ever-changing latest action hash themselves.
- Worth Holochain either documenting this distinction far more prominently
  next to `get()`'s signature specifically (not just in general prose about
  update chains elsewhere), or providing a built-in "resolve to latest by
  action hash" helper in `hdk` directly, since every non-trivial app
  reaching for this ends up hand-rolling the same small helper.

---

## 5. `Entry::to_app_option()` silently fails to decode a countersigned entry

**This app no longer uses countersigning** (2026-10-09): delivery handoffs
are now two plain entries -- the driver's record and the other party's
acknowledgment. One more reason, found while building a desktop runtime: no
official 0.7.0 binary ships countersigning, not even the
`holochain-unstable-*` release build (a hApp using it fails to load there
with the same import error). Sections 5 and 6 are kept as findings.

**Classification:** Bug / real inconsistency — the strongest candidate for
an actual defect in this whole document. The same crate, via the same
derive macro (`#[hdk_entry_helper]`), generates a `TryFrom<&Entry>` impl
that *does* handle the `CounterSign` wire shape correctly for the identical
struct. That's not a documentation gap or a mental-model mismatch on our
part — it's one convenience method on a type not covering a case its own
sibling method, generated from the same macro, already knows how to
handle. If this were intended, the `TryFrom` impl would presumably have the
same restriction.

**Component:** `hdi 0.7.3`, `Entry::to_app_option()`

**Re-checked against hdi 0.8.0 (2026-09-28), confirmed by direct byte-diff of
the actual method, not assumed:** `to_app_option()`'s implementation in
`holochain_integrity_types-0.7.0/src/record.rs` (the crate hdi 0.8.0
re-exports it from) is character-for-character identical to the 0.6.3
version — still `match self.as_option()... { Some(Entry::App(eb)) => ...,
_ => Ok(None) }`, still no `Entry::CounterSign` arm. Not fixed by this
upgrade. The `TryFrom<&Entry>` workaround below is unaffected and remains
necessary; this codebase's own `dispatch_integrity` (added 2026-09-27, on
0.6.3, per the architecture plan's completion-gate section) already uses it
and needed no changes post-upgrade.

**Description:** `to_app_option()` only matches the `Entry::App` variant.
A countersigned entry's actual wire shape is `Entry::CounterSign(session_data,
bytes)` — calling `to_app_option()` on one silently returns `None` ("not an
entry of this type"), rather than an error or a decoded value, even though
the entry genuinely is a valid instance of the expected struct.

**Why it matters:** Every genuine countersigned entry reference (in this
project: a `ReceiptAttestation`, created via native Holochain
countersigning between two parties) was being rejected as "not the expected
entry type" by any code path using `to_app_option()` — including inside
deterministic `validate()`, where a completion-gate check needs to confirm a
referenced attestation is real. The failure mode (`None`, not an error) is
exactly the same as "this hash points at something else entirely," making
it easy to misdiagnose as a wrong-reference bug rather than a decode gap.

**Fix / workaround:** Use the `TryFrom<&Entry>` impl that `#[hdk_entry_helper]`
generates instead of `to_app_option()` when the entry in question might be
countersigned — that impl does handle the `CounterSign` wire shape
correctly. `to_app_option()` remains fine for entries that are never
countersigned. Worth Holochain either fixing `to_app_option()` to handle
`CounterSign` directly (most call sites reasonably expect "give me the app
entry if there is one" to work regardless of how it was committed), or at
minimum documenting the gap prominently next to `to_app_option()` itself.

---

## 6. Non-enzymatic countersigning doesn't reliably finalize on a small/fresh network

**Classification:** Reconsidered from the original framing — closer to
"correct-by-design, we needed to adapt" than a Holochain reliability bug.
The `enzymatic` flag exists specifically as an alternative finalization
mode, which is a strong signal the Holochain team is already aware
non-enzymatic (DHT-authority-based) finalization can struggle on some
topologies — that's a documented tradeoff with an escape hatch provided,
not a defect. The more accurate framing: this project picked the wrong
default for a small/fresh test network, and Holochain already ships the
fix as a config option. Kept in this document because the failure mode
(session times out with no clear signal of *why*) is genuinely hard to
diagnose from the outside, not because non-enzymatic mode itself is broken.

**Component:** `hdk 0.6.3`, `unstable-countersigning` feature, `PreflightRequest`

**Re-checked against 0.7.0 (2026-09-28):** the `unstable-countersigning`
feature flag still exists in holochain 0.7.0's own Cargo.toml (confirmed via
`gh api` before reinstalling the toolchain — see the architecture plan's §0)
and still must be passed explicitly at `cargo install` time; omitting it
still fails at zome-load time with a cryptic wasm import error, not an
obviously-countersigning-related one — this project hit that exact failure
again during the upgrade and fixed it the same way. `enzymatic: true` remains
set on every `PreflightRequest` in this codebase and the full attestation/
dispute/cancellation-dispute test suite (all countersigning-dependent) passed
unchanged post-upgrade, which is a real, if indirect, empirical re-confirmation
that this workaround still holds on 0.7.0. Whether non-enzymatic mode's
underlying reliability gap was itself addressed in 0.7.0 was not re-tested
(this project has no reason to run non-enzymatic mode, so there's no
regression signal either way) — treat that specific sub-question as open,
not re-confirmed.

**Description:** With a non-enzymatic countersigning session (the default),
both parties' preflight round-trip and trial `create()` calls can succeed
with byte-identical decoded content, yet the resulting entry never durably
lands on *either* party's chain — the chain lock only releases after the
full session timeout, indicating the session timed out rather than
resolved. Root cause: non-enzymatic finalization depends on some peer
currently holding DHT-basis authority over the entry's hash to gather both
signed actions and return a signature bundle. On a small or freshly-started
network, that authority resolution can fail to complete before the session
times out.

**Why it matters:** Countersigning is Holochain's primary mechanism for
dual-party-agreed commits (used here for delivery-completion receipts), and
this failure mode reproduces reliably on exactly the kind of small,
freshly-spun-up network that integration tests (and early-stage real
deployments) run on — not an edge case, but close to the default condition
during development and testing.

**Fix / workaround:** Set `enzymatic: true` on the `PreflightRequest`. This
makes the first signing agent a designated authority that both parties push
their signed action to directly, bypassing DHT-authority resolution
entirely. With this set, sessions finalize durably on both chains, resolving
on the first attempt rather than waiting out a timeout. Two smaller,
related gotchas found alongside this: a countersigning `create()` must be
the *only* action in its zome-call flush (bundling a `create_link` alongside
it triggers a `DirtyCounterSigningWrite` error), and reads immediately after
a countersigned commit should use `GetStrategy::Local` rather than the
`Network` default on a sparse test network.

---

## 7. DPKI/DeepKey's conductor-config section was removed from the default path as of 0.6.1

**Classification:** Acknowledged incomplete feature — this is openly known
by the Holochain team as unfinished (the config section's removal from the
default path is itself the team's own acknowledgment that it isn't ready),
not something uncovered by surprise. Holds up as originally written; no
correction needed here.

**Component:** `holochain 0.6.3` conductor configuration

**Re-checked against 0.7.0 (2026-09-28):** still applies, unchanged. The
0.6.3→0.7.0 changelog range and Holochain's own public roadmap (both reviewed
directly as part of deciding whether to do this upgrade at all — see the
architecture plan's §0) contain no DPKI/DeepKey conductor-config work; the
"warrants reaching complete status" roadmap item is attributed to the
still-pre-release 0.8 line, not 0.7.0. The interim app-level `RevocationList`
workaround remains the right posture; nothing here changed.

**Description:** As of 0.6.1, Holochain's DPKI implementation (DeepKey) no
longer has a config section on the default installation path. There is
currently no default key rotation, no cross-device multi-key binding, and
no built-in revocation registry.

**Why it matters:** Any application with a real requirement to revoke an
agent's access (a compromised key, a revoked credential/license) has no
first-party Holochain mechanism to do so today. This is a genuine product
and compliance gap for any app where "we can cut off a specific agent" is a
real requirement, not a nice-to-have — worth surfacing explicitly to
stakeholders rather than discovering it after launch.

**Fix / workaround:** No first-party fix available yet — this is genuinely
unfinished in current Holochain, not a misunderstanding of an existing
feature. The interim, explicitly-named workaround used in this project's
design: an app-level `RevocationList` entry, authored by a small set of
designated trust-anchor agents, checked at the point where a credential
matters (e.g. before accepting a bid from a given provider) — a deliberate,
temporary, semi-centralized exception, named as such rather than presented
as fully decentralized. Track DeepKey's stabilization for when this can be
replaced with a first-party mechanism.
