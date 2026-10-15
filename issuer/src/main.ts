// The issuer service: connects to the issuer's conductor, publishes its
// terms, takes card top-ups and payout-account setups over HTTP, and sweeps
// cash-outs on a timer. Configured from the environment (.env.example).
import { loadConfig } from "./config.ts";
import { connectIssuerLedger } from "./ledger.ts";
import { sweep } from "./payouts.ts";
import { serve } from "./server.ts";
import { reissueSweep } from "./recovery.ts";
import { reconcile, RECONCILE_WINDOW_MS } from "./topups.ts";
import { Store } from "./store.ts";
import { stripeRail } from "./stripe.ts";

const config = loadConfig();
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const store = new Store(config.dbPath);
const ledger = await connectIssuerLedger(config.conductorAdminUrl, config.issuerAppId);
// Every amount is in the network's currency, whichever country it runs in.
const currency = await ledger.currency();
const rail = stripeRail(config.stripeSecretKey, config.stripeWebhookSecret, config.publicUrl, currency);
const fee = { payoutFeeCents: config.profile.payoutFeeCents, payoutFeeBasisPoints: config.profile.payoutFeeBasisPoints };
const money = new Intl.NumberFormat("en", { style: "currency", currency });
const format = (minor: number) => money.format(minor / 10 ** (money.resolvedOptions().maximumFractionDigits ?? 2));
const payoutDeps = { store, ledger, rail, fee, policy: config.risk, format };

await ledger.setProfile({
  name: config.profile.name,
  description: "Pay by card or Apple Pay at checkout, free. Cash out to your bank, or unspent funds back to your card: the fee covers card and transfer costs.",
  contact: config.profile.contact,
  payout_fee_cents: config.profile.payoutFeeCents,
  payout_fee_basis_points: config.profile.payoutFeeBasisPoints,
  min_payout_cents: config.profile.minPayoutCents,
  payout_days: config.profile.payoutDays,
  service_url: config.publicUrl,
  recovery_wait_days: Math.round(config.recoveryWaitMs / (24 * 60 * 60 * 1000)),
});
log(`published ${config.profile.name}'s terms; service at ${config.publicUrl}`);

serve(
  { store, ledger, rail, appOrigins: config.appOrigins, publishableKey: config.stripePublishableKey, policy: config.risk, topUpsPerIpPerHour: config.topUpsPerIpPerHour, trustProxy: config.trustProxy, format, log },
  config.port,
);
log(`listening on :${config.port}`);

// One sweep at a time; a failed one is retried on the next tick from where
// it stopped.
let sweeping = false;
setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    const decided = await sweep(payoutDeps);
    if (decided) log(`decided ${decided} cash-out${decided === 1 ? "" : "s"}`);
  } catch (err) {
    log(`sweep failed, retrying next time: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    sweeping = false;
  }
}, config.sweepSeconds * 1000);

// Every few minutes, every payment of the last week is checked for its
// grant: a webhook that never arrived is granted here, once.
let reconciling = false;
setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    const granted = await reconcile(store, ledger, await rail.paymentsSince(Date.now() - RECONCILE_WINDOW_MS));
    if (granted) log(`reconciled ${granted} payment${granted === 1 ? "" : "s"} that had no grant`);
  } catch (err) {
    log(`reconciliation failed, retrying next time: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    reconciling = false;
  }
}, 5 * 60_000);

// Recovered accounts' balances, reissued once the old key has been quiet
// long enough (recovery.ts).
let reissuing = false;
setInterval(async () => {
  if (reissuing) return;
  reissuing = true;
  try {
    await reissueSweep(store, ledger, config.recoveryWaitMs, config.recoveryReviewAboveCents, log);
  } catch (err) {
    log(`recovery sweep failed, retrying next time: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    reissuing = false;
  }
}, 10 * 60_000);
