// The wallet: a balance, where money comes from (the network's issuers), and
// cashing it out through one -- with each cash-out's progress, from asked
// to paid. The network never holds anyone's money; an issuer pays it out
// through its processor and records what it did (see the ledger zome's
// `cash_out`).
import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowDownToLine, ArrowUpRight, Banknote, ChevronRight, Clock3, Landmark, Wallet as WalletIcon } from "lucide-react";
import { cashOut, getBalance, listIssuers, listMyCashOuts } from "../holochain/zomes/ledger";
import { bytesToHex } from "../holochain/decode";
import type { CashOutView, IssuerView } from "../holochain/types";
import { MAX_NOTE_CHARS } from "../holochain/types";
import { Badge, Button, Card, Field, Input, Skeleton, StatNumber, Textarea } from "../components/ui";
import { InfoTip } from "../components/InfoTip";
import { Sheet } from "../components/Sheet";
import { describeError } from "../lib/errors";
import { currencySymbol, formatCents, fromMinorUnits, toMinorUnits } from "../lib/format";
import { fadeSlideUp, staggerContainer } from "../lib/motion";
import { POLL } from "../lib/poll";
import { useResource } from "../lib/useResource";
import { cashOutStatusLabel, collectIncoming, feeLabel, payoutAfterFees } from "../lib/wallet";
import { useSession } from "../store/session";
import { useTerms } from "../store/network";

interface WalletData {
  balance: number;
  cashOuts: CashOutView[];
  issuers: IssuerView[];
}

async function fetchWallet(agent: Uint8Array): Promise<WalletData> {
  // What's owed in from outside an order lands first, so the balance shown
  // includes it.
  await collectIncoming().catch(() => 0);
  const [balance, cashOuts, issuers] = await Promise.all([getBalance(agent), listMyCashOuts(), listIssuers()]);
  return { balance, cashOuts, issuers };
}

export function Wallet() {
  const { agentPubKey, profile } = useSession();
  const hex = agentPubKey ? bytesToHex(agentPubKey) : null;
  const { data, reload } = useResource(hex && `wallet:${hex}`, () => fetchWallet(agentPubKey!), { pollMs: POLL.unsignalled });
  const [cashingOut, setCashingOut] = useState(false);
  const terms = useTerms();
  const isMerchant = !!profile?.roles.includes("Merchant");

  if (!data) {
    return (
      <div className="px-4 pt-4">
        <Skeleton className="mb-4 h-8 w-32" />
        <Skeleton className="mb-4 h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  const issuerName = (issuer: Uint8Array) => data.issuers.find((i) => bytesToHex(i.issuer) === bytesToHex(issuer))?.profile?.name ?? "An issuer";
  const available = Math.max(0, data.balance);
  const canCashOut = data.issuers.length > 0 && available >= terms.min_redemption_cents;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.h1 variants={fadeSlideUp} className="mb-4 text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        Wallet
      </motion.h1>

      <motion.div variants={fadeSlideUp}>
        <Card className="mb-4 p-5">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-relay-100 text-relay-600 dark:bg-relay-900/30">
              <WalletIcon size={20} />
            </span>
            <div>
              <p className="text-xs text-ink-400">Balance</p>
              <StatNumber className="text-3xl" tone={data.balance < 0 ? "danger" : "default"}>
                {formatCents(data.balance)}
              </StatNumber>
            </div>
          </div>
          {data.balance < 0 && <p className="mt-3 text-xs text-ink-500">This network lets your balance run below zero; you'll need to add funds before you can cash out.</p>}
          <Button className="mt-4 w-full" disabled={!canCashOut} onClick={() => setCashingOut(true)}>
            <ArrowUpRight size={16} /> Cash out
          </Button>
          {!canCashOut && (
            <p className="mt-2 text-center text-xs text-ink-400">
              {data.issuers.length === 0 ? "This network has no issuer to pay out through yet." : `You can cash out once you have ${formatCents(terms.min_redemption_cents)} or more.`}
            </p>
          )}
        </Card>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Section title="Cash-outs">
          {data.cashOuts.length === 0 ? (
            <p className="p-4 text-sm text-ink-400">Nothing cashed out yet. Your earnings stay in your balance until you do.</p>
          ) : (
            <ul className="divide-y divide-ink-100 dark:divide-ink-800">
              {data.cashOuts.map((c) => (
                <CashOutRow key={bytesToHex(c.redemption)} cashOut={c} issuerName={issuerName(c.issuer)} />
              ))}
            </ul>
          )}
        </Section>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Section title="Adding funds">
          {data.issuers.length === 0 ? (
            <p className="p-4 text-sm text-ink-400">This network has no issuer yet.</p>
          ) : (
            <ul className="divide-y divide-ink-100 dark:divide-ink-800">
              {data.issuers.map((i) => (
                <li key={bytesToHex(i.issuer)} className="flex items-start gap-3 p-4">
                  <Landmark size={18} className="mt-0.5 shrink-0 text-ink-400" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{i.profile?.name ?? "Unnamed issuer"}</p>
                    {i.profile?.description && <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{i.profile.description}</p>}
                    {i.profile?.contact && <p className="mt-1 break-all text-xs text-ink-400">{i.profile.contact}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Link to="/transparency" className="flex items-center gap-3 rounded-2xl border border-ink-100 bg-white p-4 dark:border-ink-800 dark:bg-ink-900">
          <ArrowDownToLine size={18} className="text-ink-400" />
          <span className="flex-1 text-sm font-semibold text-ink-900 dark:text-ink-50">Every payment in and out</span>
          <ChevronRight size={16} className="text-ink-300" />
        </Link>
      </motion.div>

      {cashingOut && (
        <CashOutSheet
          available={available}
          issuers={data.issuers}
          minimum={terms.min_redemption_cents}
          merchant={isMerchant}
          onClose={() => setCashingOut(false)}
          onDone={async () => {
            setCashingOut(false);
            await reload();
          }}
        />
      )}
    </motion.div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">{title}</p>
      <Card className="overflow-hidden">{children}</Card>
    </div>
  );
}

function CashOutRow({ cashOut, issuerName }: { cashOut: CashOutView; issuerName: string }) {
  const { label, tone } = cashOutStatusLabel(cashOut.status);
  const status = cashOut.status;
  const detail = status === "Pending" ? null : "Paid" in status ? `Reference ${status.Paid.reference}` : "Declined" in status ? status.Declined.reason : status.Returned.reason;
  return (
    <li className="flex items-start gap-3 p-4">
      <Banknote size={18} className="mt-0.5 shrink-0 text-ink-400" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <StatNumber className="text-sm">{formatCents(cashOut.amount)}</StatNumber>
          <Badge tone={tone}>{label}</Badge>
        </div>
        <p className="mt-0.5 text-xs text-ink-400">
          {issuerName} · {new Date(cashOut.requested_at / 1000).toLocaleDateString([], { month: "short", day: "numeric" })}
        </p>
        {detail && <p className="mt-1 break-all text-xs text-ink-500">{detail}</p>}
      </div>
    </li>
  );
}

function CashOutSheet({
  available,
  issuers,
  minimum,
  merchant,
  onClose,
  onDone,
}: {
  available: number;
  issuers: IssuerView[];
  minimum: number;
  merchant: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [issuerHex, setIssuerHex] = useState(bytesToHex(issuers[0].issuer));
  const [amount, setAmount] = useState(fromMinorUnits(available).toFixed(2));
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = issuers.find((i) => bytesToHex(i.issuer) === issuerHex) ?? issuers[0];
  const profile = chosen.profile;
  const cents = toMinorUnits(Number(amount) || 0);
  const least = Math.max(minimum, profile?.min_payout_cents ?? 0);
  const problem = cents < least ? `Cash out ${formatCents(least)} or more.` : cents > available ? `You have ${formatCents(available)} to cash out.` : null;
  const net = profile ? payoutAfterFees(profile, cents) : cents;

  async function submit() {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      await cashOut(chosen.issuer, cents, instructions.trim());
      await onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Cash out"
      subtitle="Your issuer pays it to you outside the network."
      footer={
        <>
          {(error || problem) && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error ?? problem}</p>}
          <Button className="w-full" disabled={!!problem} loading={busy} onClick={submit}>
            Cash out {formatCents(cents)}
          </Button>
        </>
      }
    >
      {issuers.length > 1 && (
        <div role="radiogroup" aria-label="Pay out through" className="mb-4 flex flex-col gap-2">
          {issuers.map((i) => {
            const hex = bytesToHex(i.issuer);
            const selected = hex === issuerHex;
            return (
              <button
                key={hex}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setIssuerHex(hex)}
                className={`rounded-2xl border p-3 text-left transition ${selected ? "border-relay-500 bg-relay-50/50 dark:bg-relay-900/10" : "border-ink-100 dark:border-ink-800"}`}
              >
                <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{i.profile?.name ?? "Unnamed issuer"}</p>
                {i.profile && <p className="text-xs text-ink-500">{feeLabel(i.profile, formatCents)} · usually {i.profile.payout_days} day{i.profile.payout_days === 1 ? "" : "s"}</p>}
              </button>
            );
          })}
        </div>
      )}

      <Field label="Amount">
        <div className="flex gap-2">
          <div className="flex-1">
            <Input type="number" inputMode="decimal" min={0} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} prefix={currencySymbol()} />
          </div>
          <Button variant="ghost" className="px-3 py-2 text-xs" onClick={() => setAmount(fromMinorUnits(available).toFixed(2))}>
            All {formatCents(available)}
          </Button>
        </div>
      </Field>

      <div className="mt-4 rounded-2xl bg-ink-50 p-4 dark:bg-ink-800/60">
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-500">{profile ? feeLabel(profile, formatCents) : "Fee"}</span>
          <span className="tabular-nums text-ink-700 dark:text-ink-200">{formatCents(cents - net)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-sm font-semibold text-ink-900 dark:text-ink-50">You'll receive</span>
          <StatNumber className="text-lg">{formatCents(net)}</StatNumber>
        </div>
        {profile && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-400">
            <Clock3 size={12} /> Usually arrives within {profile.payout_days} day{profile.payout_days === 1 ? "" : "s"}, from {profile.name}.
          </p>
        )}
      </div>

      <div className="mt-4">
        <div className="mb-1 flex items-center gap-1">
          <span className="text-xs font-semibold text-ink-500">Payout details (optional)</span>
          <InfoTip label="Who can read this">Sealed so only {profile?.name ?? "the issuer"} can read it. Most people set up their payout account with the issuer once and leave this empty.</InfoTip>
        </div>
        <Textarea rows={2} maxLength={MAX_NOTE_CHARS} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Only if your issuer asks for it" />
      </div>

      {merchant && (
        <p className="mt-4 text-xs leading-relaxed text-ink-500">
          Your stores set aside each driver's fee from this balance when they check a driver in. Keep enough for your next orders, or stores can't accept deliveries.
        </p>
      )}
    </Sheet>
  );
}
