// Paying by card into the caller's balance, without leaving the app: the
// card they saved last time in one tap, or the issuer's embedded card form
// (Stripe's own, in its own frame -- card details never touch Relay; Apple
// Pay and Google Pay show where the device and domain allow). Then it waits
// for the funds to land, and says so.
import { useCallback, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { CreditCard, Loader2 } from "lucide-react";
import { getBalance } from "../holochain/zomes/ledger";
import type { AgentPubKey } from "../holochain/types";
import { bytesToHex } from "../holochain/decode";
import { Button, Skeleton } from "./ui";
import { Sheet } from "./Sheet";
import { describeError } from "../lib/ui/errors";
import { formatCents } from "../lib/ui/format";
import { cardFormSecret, payWithSavedCard, publishableKey, savedCard, type PayableIssuer } from "../lib/money/issuerService";
import { POLL } from "../lib/network/poll";
import { usePolling, useResource } from "../lib/hooks/useResource";
import { collectIncoming } from "../lib/money/wallet";
import { t as translate, useT } from "../i18n";

/// How long to wait on the funds before saying they'll come shortly.
const LANDING_PATIENCE_MS = 60_000;

type Step =
  /// Choosing: the saved card, or another.
  | { kind: "choose" }
  /// The issuer's card form.
  | { kind: "form" }
  /// Paid; waiting for the funds to reach the balance, which stood at
  /// `from` before.
  | { kind: "landing"; from: number; since: number }
  /// Paid, and the funds are taking longer than usual.
  | { kind: "slow" };

export function CardPaySheet({
  issuer,
  agent,
  amount: requested,
  title,
  subtitle,
  onClose,
  onPaid,
}: {
  /// An issuer with a service to pay through.
  issuer: PayableIssuer;
  agent: AgentPubKey;
  amount: number;
  title: string;
  subtitle: string;
  onClose: () => void;
  /// The funds are in the balance.
  onPaid: () => void | Promise<void>;
}) {
  const t = useT();
  // What's being paid, fixed for the sheet's life: a parent re-reading its
  // data mustn't remount a card form someone's typing into.
  const [{ serviceUrl, issuerKey, amount }] = useState(() => ({
    serviceUrl: issuer.profile.service_url,
    issuerKey: issuer.issuer,
    amount: requested,
  }));
  const { data: card, error: cardError } = useResource(`saved-card:${bytesToHex(issuerKey)}:${bytesToHex(agent)}`, () => savedCard(serviceUrl, issuerKey, agent));
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /// Waits for the payment's funds, from a balance of `from` -- read before
  /// any money moves, so the grant can't come first.
  const awaitFunds = useCallback((from: number) => setStep({ kind: "landing", from, since: Date.now() }), []);

  usePolling(
    async () => {
      if (step.kind !== "landing") return;
      await collectIncoming().catch(() => 0);
      if ((await getBalance(agent)) >= step.from + amount) await onPaid();
      else if (Date.now() - step.since > LANDING_PATIENCE_MS) setStep({ kind: "slow" });
    },
    { pollMs: POLL.payment, background: true },
    step.kind === "landing",
  );

  async function payWithCard() {
    setBusy(true);
    setError(null);
    try {
      const from = await getBalance(agent);
      // Or their bank wants them to confirm it: the card form does that.
      if (await payWithSavedCard(serviceUrl, issuerKey, agent, amount)) awaitFunds(from);
      else setStep({ kind: "form" });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // The card form, mounted into its node and destroyed with it. Stripe
  // allows one at a time, so it's torn down the moment the node goes.
  const mountForm = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      let gone = false;
      let destroy = () => {};
      (async () => {
        const stripe = await loadStripe(await publishableKey(serviceUrl));
        if (!stripe) throw new Error(translate("card.loadFailed"));
        const from = await getBalance(agent);
        if (gone) return;
        const form = await stripe.initEmbeddedCheckout({
          fetchClientSecret: () => cardFormSecret(serviceUrl, issuerKey, agent, amount),
          onComplete: () => awaitFunds(from),
        });
        if (gone) return form.destroy();
        destroy = () => form.destroy();
        form.mount(node);
      })().catch((err) => !gone && setError(describeError(err)));
      return () => {
        gone = true;
        destroy();
      };
    },
    [serviceUrl, issuerKey, agent, amount, awaitFunds],
  );

  const waiting = step.kind === "landing" || step.kind === "slow";
  // No card yet, or the service can't say: straight to the form.
  const noSavedCard = card === null || (card === undefined && !!cardError);

  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      footer={
        step.kind === "choose" && card ? (
          <>
            {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            <Button className="w-full" loading={busy} onClick={payWithCard}>
              {t("card.payWith", { amount: formatCents(amount), card: `${cardName(card.brand)} •••• ${card.last4}` })}
            </Button>
            <button type="button" onClick={() => setStep({ kind: "form" })} className="mt-3 w-full text-center text-xs font-semibold text-ink-500 hover:text-ink-700 dark:hover:text-ink-300">
              {t("card.another")}
            </button>
          </>
        ) : step.kind === "slow" ? (
          <Button variant="ghost" className="w-full" onClick={onClose}>
            {t("common.close")}
          </Button>
        ) : undefined
      }
    >
      {waiting ? (
        <div className="flex flex-col items-center py-8 text-center">
          {step.kind === "landing" ? <Loader2 size={28} className="animate-spin text-relay-500" /> : <CreditCard size={28} className="text-ink-400" />}
          <p className="mt-3 text-sm font-semibold text-ink-900 dark:text-ink-50">{step.kind === "landing" ? t("card.adding", { amount: formatCents(amount) }) : t("card.wentThrough")}</p>
          <p className="mt-1 max-w-xs text-xs text-ink-500">
            {step.kind === "landing" ? t("card.fewSeconds") : t("card.slow")}
          </p>
        </div>
      ) : step.kind === "form" || noSavedCard ? (
        <>
          {error && <p className="mb-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div ref={mountForm} className="min-h-[24rem]" />
        </>
      ) : card ? (
        <div className="flex items-center gap-3 rounded-2xl border border-ink-100 p-4 dark:border-ink-800">
          <CreditCard size={20} className="text-ink-400" />
          <div>
            <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">
              {cardName(card.brand)} •••• {card.last4}
            </p>
            <p className="text-xs text-ink-400">{t("card.savedWith", { issuer: issuer.profile.name })}</p>
          </div>
        </div>
      ) : (
        <Skeleton className="h-16 w-full" />
      )}
    </Sheet>
  );
}

/// A card brand as people say it.
function cardName(brand: string): string {
  const names: Record<string, string> = {
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "Amex",
    discover: "Discover",
    jcb: "JCB",
    diners: "Diners",
    unionpay: "UnionPay",
  };
  return names[brand] ?? translate("card.generic");
}
