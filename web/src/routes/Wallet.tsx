// The wallet: a balance, where money comes from (the network's issuers), and
// cashing it out through one -- with each cash-out's progress, from asked
// to paid. The network never holds anyone's money; an issuer pays it out
// through its processor and records what it did (see the ledger zome's
// `cash_out`).
import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowDownToLine, ArrowUpRight, Banknote, ChevronRight, Clock3, Landmark, Plus, RefreshCw, Wallet as WalletIcon } from "lucide-react";
import { cashOut, getBalance, listIssuers, listMyCashOuts } from "../holochain/zomes/ledger";
import { bytesToHex } from "../holochain/decode";
import type { CashOutView, IssuerView } from "../holochain/types";
import { MAX_NOTE_CHARS } from "../holochain/types";
import { Badge, Button, Card, Field, Input, Select, Skeleton, StatNumber, Switch, Textarea } from "../components/ui";
import { CardPaySheet } from "../components/CardPaySheet";
import { InfoTip } from "../components/InfoTip";
import { Sheet } from "../components/Sheet";
import { describeError } from "../lib/ui/errors";
import { currencySymbol, formatCents, fromMinorUnits, toMinorUnits } from "../lib/ui/format";
import { fadeSlideUp, staggerContainer } from "../lib/ui/motion";
import { POLL } from "../lib/network/poll";
import { useResource } from "../lib/hooks/useResource";
import { cashOutStatusLabel, collectIncoming, feeLabel, payoutAfterFees } from "../lib/money/wallet";
import { isPayable, MAX_CARD_PAYMENT_CENTS, MIN_CARD_PAYMENT_CENTS, payoutSetupUrl, savedCard, type PayableIssuer } from "../lib/money/issuerService";
import { useSession } from "../store/session";
import { useCustomerSettings } from "../store/roleSettings";
import { useTerms } from "../store/network";
import { appLocale, useT } from "../i18n";

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
  const t = useT();
  const hex = agentPubKey ? bytesToHex(agentPubKey) : null;
  const { data, reload } = useResource(hex && `wallet:${hex}`, () => fetchWallet(agentPubKey!), { pollMs: POLL.unsignalled });
  const [cashingOut, setCashingOut] = useState(false);
  /// The issuer funds are being added through, if any.
  const [addingFundsWith, setAddingFundsWith] = useState<PayableIssuer | null>(null);
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
  const issuerName = (issuer: Uint8Array) => data.issuers.find((i) => bytesToHex(i.issuer) === bytesToHex(issuer))?.profile?.name ?? t("wallet.anIssuer");
  const available = Math.max(0, data.balance);
  const canCashOut = data.issuers.length > 0 && available >= terms.min_redemption_cents;
  const payable = data.issuers.filter(isPayable);

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.h1 variants={fadeSlideUp} className="mb-4 text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        {t("wallet.title")}
      </motion.h1>

      <motion.div variants={fadeSlideUp}>
        <Card className="mb-4 p-5">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-handshake-100 text-handshake-600 dark:bg-handshake-900/30">
              <WalletIcon size={20} />
            </span>
            <div>
              <p className="text-xs text-ink-400">{t("wallet.balance")}</p>
              <StatNumber className="text-3xl" tone={data.balance < 0 ? "danger" : "default"}>
                {formatCents(data.balance)}
              </StatNumber>
            </div>
          </div>
          {data.balance < 0 && <p className="mt-3 text-xs text-ink-500">{t("wallet.belowZero")}</p>}
          <Button className="mt-4 w-full" disabled={!canCashOut} onClick={() => setCashingOut(true)}>
            <ArrowUpRight size={16} /> {t("wallet.cashOut")}
          </Button>
          {!canCashOut && (
            <p className="mt-2 text-center text-xs text-ink-400">
              {data.issuers.length === 0 ? t("wallet.noIssuerPayout") : t("wallet.minimum", { amount: formatCents(terms.min_redemption_cents) })}
            </p>
          )}
        </Card>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Section title={t("wallet.cashOuts")}>
          {data.cashOuts.length === 0 ? (
            <p className="p-4 text-sm text-ink-400">{t("wallet.noCashOuts")}</p>
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
        <Section title={t("wallet.issuers")}>
          {data.issuers.length === 0 ? (
            <p className="p-4 text-sm text-ink-400">{t("wallet.noIssuer")}</p>
          ) : (
            <ul className="divide-y divide-ink-100 dark:divide-ink-800">
              {data.issuers.map((i) => (
                <IssuerRow key={bytesToHex(i.issuer)} issuer={i} agent={agentPubKey!} onAddFunds={isPayable(i) ? () => setAddingFundsWith(i) : null} />
              ))}
            </ul>
          )}
        </Section>
      </motion.div>

      {payable.length > 0 && (
        <motion.div variants={fadeSlideUp}>
          <Section title={t("wallet.autoTopUp")}>
            <AutoTopUpRow issuer={payable[0]} agent={agentPubKey!} />
          </Section>
        </motion.div>
      )}

      <motion.div variants={fadeSlideUp}>
        <Link to="/transparency" className="flex items-center gap-3 rounded-2xl border border-ink-100 bg-white p-4 dark:border-ink-800 dark:bg-ink-900">
          <ArrowDownToLine size={18} className="text-ink-400" />
          <span className="flex-1 text-sm font-semibold text-ink-900 dark:text-ink-50">{t("wallet.everyPayment")}</span>
          <ChevronRight size={16} className="text-ink-300" />
        </Link>
      </motion.div>

      {addingFundsWith && (
        <AddFundsSheet
          issuer={addingFundsWith}
          agent={agentPubKey!}
          onClose={() => setAddingFundsWith(null)}
          onPaid={async () => {
            setAddingFundsWith(null);
            await reload();
          }}
        />
      )}

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

/// An issuer: who it is, and -- when the app can reach its service -- adding
/// funds through it and setting up a payout account with it.
function IssuerRow({ issuer, agent, onAddFunds }: { issuer: IssuerView; agent: Uint8Array; onAddFunds: (() => void) | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = issuer.profile;
  const t = useT();

  async function setUpPayouts() {
    if (!profile?.service_url) return;
    setBusy(true);
    setError(null);
    try {
      // To the processor's own page: bank details never touch HandShake.
      window.location.assign(await payoutSetupUrl(profile.service_url, issuer.issuer, agent));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <li className="p-4">
      <div className="flex items-start gap-3">
        <Landmark size={18} className="mt-0.5 shrink-0 text-ink-400" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{profile?.name ?? t("wallet.unnamedIssuer")}</p>
          {profile?.description && <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{profile.description}</p>}
          {profile?.contact && <p className="mt-1 break-all text-xs text-ink-400">{profile.contact}</p>}
        </div>
      </div>
      {onAddFunds && (
        <div className="mt-3 flex gap-2">
          <Button className="flex-1 py-2 text-xs" onClick={onAddFunds}>
            <Plus size={14} /> {t("wallet.addFunds")}
          </Button>
          <Button variant="ghost" className="flex-1 py-2 text-xs" loading={busy} onClick={setUpPayouts}>
            <Landmark size={14} /> {t("wallet.payoutAccount")}
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </li>
  );
}

/// Amounts offered at a tap, in minor units.
const TOP_UP_PRESETS = [2000, 5000, 10_000];

/// Adding funds by card: an amount, then paying it in the app.
function AddFundsSheet({ issuer, agent, onClose, onPaid }: { issuer: PayableIssuer; agent: Uint8Array; onClose: () => void; onPaid: () => Promise<void> }) {
  const [amount, setAmount] = useState("50.00");
  const t = useT();
  const [paying, setPaying] = useState(false);
  const cents = toMinorUnits(Number(amount) || 0);
  const problem =
    cents < MIN_CARD_PAYMENT_CENTS ? t("wallet.addAtLeast", { amount: formatCents(MIN_CARD_PAYMENT_CENTS) }) : cents > MAX_CARD_PAYMENT_CENTS ? t("wallet.addAtMost", { amount: formatCents(MAX_CARD_PAYMENT_CENTS) }) : null;

  if (paying) {
    return <CardPaySheet issuer={issuer} agent={agent} amount={cents} title={t("wallet.addAmount", { amount: formatCents(cents) })} subtitle={t("wallet.paidThrough", { issuer: issuer.profile.name })} onClose={onClose} onPaid={onPaid} />;
  }
  return (
    <Sheet
      open
      onClose={onClose}
      title={t("wallet.addFunds")}
      subtitle={t("wallet.addSubtitle", { issuer: issuer.profile.name })}
      footer={
        <>
          {problem && amount !== "" && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{problem}</p>}
          <Button className="w-full" disabled={!!problem} onClick={() => setPaying(true)}>
            {t("common.continue")} · {formatCents(cents)}
          </Button>
        </>
      }
    >
      <div className="mb-3 grid grid-cols-3 gap-2">
        {TOP_UP_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setAmount(fromMinorUnits(preset).toFixed(2))}
            className={`rounded-xl py-2.5 text-sm font-semibold transition ${cents === preset ? "bg-handshake-500 text-white" : "bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200"}`}
          >
            {formatCents(preset)}
          </button>
        ))}
      </div>
      <Field label={t("wallet.amount")}>
        <Input type="number" inputMode="decimal" min={0} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} prefix={currencySymbol()} />
      </Field>
      <p className="mt-3 text-xs text-ink-400">{t("wallet.addNote")}</p>
    </Sheet>
  );
}

/// Balances below which auto top-up pays, and what it adds -- in minor units.
const AUTO_TOP_UP_BELOW = [1000, 2000, 5000];
const AUTO_TOP_UP_AMOUNTS = [2500, 5000, 10_000];

/// Auto top-up through `issuer`, with the card saved there.
function AutoTopUpRow({ issuer, agent }: { issuer: PayableIssuer; agent: Uint8Array }) {
  const hex = bytesToHex(agent);
  const setting = useCustomerSettings((s) => s.autoTopUps[hex]);
  const t = useT();
  const setAutoTopUp = useCustomerSettings((s) => s.setAutoTopUp);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function turn(on: boolean) {
    setError(null);
    if (!on) return setAutoTopUp(hex, null);
    setBusy(true);
    try {
      // It charges the card saved last time: there has to be one.
      if (!(await savedCard(issuer.profile.service_url, issuer.issuer, agent))) {
        setError(t("wallet.needCard"));
        return;
      }
      setAutoTopUp(hex, { issuer: bytesToHex(issuer.issuer), belowCents: AUTO_TOP_UP_BELOW[0], amountCents: AUTO_TOP_UP_AMOUNTS[0] });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-start gap-3">
        <RefreshCw size={18} className="mt-0.5 shrink-0 text-ink-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("wallet.autoTitle")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{t("wallet.autoDetail", { issuer: issuer.profile.name })}</p>
        </div>
        <Switch checked={!!setting} disabled={busy} onChange={turn} label={t("wallet.autoTitle")} />
      </div>
      {setting && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Field label={t("wallet.whenBelow")}>
            <Select value={setting.belowCents} onChange={(e) => setAutoTopUp(hex, { ...setting, belowCents: Number(e.target.value) })}>
              {AUTO_TOP_UP_BELOW.map((c) => (
                <option key={c} value={c}>
                  {formatCents(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("wallet.add")}>
            <Select value={setting.amountCents} onChange={(e) => setAutoTopUp(hex, { ...setting, amountCents: Number(e.target.value) })}>
              {AUTO_TOP_UP_AMOUNTS.map((c) => (
                <option key={c} value={c}>
                  {formatCents(c)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
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
  const t = useT();
  const status = cashOut.status;
  const detail = status === "Pending" ? null : "Paid" in status ? t("wallet.reference", { reference: status.Paid.reference }) : "Declined" in status ? status.Declined.reason : status.Returned.reason;
  return (
    <li className="flex items-start gap-3 p-4">
      <Banknote size={18} className="mt-0.5 shrink-0 text-ink-400" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <StatNumber className="text-sm">{formatCents(cashOut.amount)}</StatNumber>
          <Badge tone={tone}>{label}</Badge>
        </div>
        <p className="mt-0.5 text-xs text-ink-400">
          {issuerName} · {new Date(cashOut.requested_at / 1000).toLocaleDateString(appLocale(), { month: "short", day: "numeric" })}
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
  const t = useT();
  const [amount, setAmount] = useState(fromMinorUnits(available).toFixed(2));
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = issuers.find((i) => bytesToHex(i.issuer) === issuerHex) ?? issuers[0];
  const profile = chosen.profile;
  const cents = toMinorUnits(Number(amount) || 0);
  const least = Math.max(minimum, profile?.min_payout_cents ?? 0);
  const problem = cents < least ? t("wallet.cashOutAtLeast", { amount: formatCents(least) }) : cents > available ? t("wallet.cashOutAtMost", { amount: formatCents(available) }) : null;
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
      title={t("wallet.cashOut")}
      subtitle={t("wallet.cashOutSubtitle")}
      footer={
        <>
          {(error || problem) && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error ?? problem}</p>}
          <Button className="w-full" disabled={!!problem} loading={busy} onClick={submit}>
            {t("wallet.cashOutAmount", { amount: formatCents(cents) })}
          </Button>
        </>
      }
    >
      {issuers.length > 1 && (
        <div role="radiogroup" aria-label={t("wallet.payOutThrough")} className="mb-4 flex flex-col gap-2">
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
                className={`rounded-2xl border p-3 text-left transition ${selected ? "border-handshake-500 bg-handshake-50/50 dark:bg-handshake-900/10" : "border-ink-100 dark:border-ink-800"}`}
              >
                <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{i.profile?.name ?? t("wallet.unnamedIssuer")}</p>
                {i.profile && <p className="text-xs text-ink-500">{feeLabel(i.profile, formatCents)} · {t("wallet.usuallyDays", { count: i.profile.payout_days })}</p>}
              </button>
            );
          })}
        </div>
      )}

      <Field label={t("wallet.amount")}>
        <div className="flex gap-2">
          <div className="flex-1">
            <Input type="number" inputMode="decimal" min={0} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} prefix={currencySymbol()} />
          </div>
          <Button variant="ghost" className="px-3 py-2 text-xs" onClick={() => setAmount(fromMinorUnits(available).toFixed(2))}>
            {t("wallet.all", { amount: formatCents(available) })}
          </Button>
        </div>
      </Field>

      <div className="mt-4 rounded-2xl bg-ink-50 p-4 dark:bg-ink-800/60">
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-500">{profile ? feeLabel(profile, formatCents) : t("wallet.feeLabel")}</span>
          <span className="tabular-nums text-ink-700 dark:text-ink-200">{formatCents(cents - net)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("wallet.receive")}</span>
          <StatNumber className="text-lg">{formatCents(net)}</StatNumber>
        </div>
        {profile && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-400">
            <Clock3 size={12} /> {t("wallet.arrivesWithin", { count: profile.payout_days, issuer: profile.name })}
          </p>
        )}
      </div>

      <div className="mt-4">
        <div className="mb-1 flex items-center gap-1">
          <span className="text-xs font-semibold text-ink-500">{t("wallet.details")}</span>
          <InfoTip label={t("wallet.whoReads")}>{t("wallet.sealedTo", { issuer: profile?.name ?? t("wallet.theIssuer") })}</InfoTip>
        </div>
        <Textarea rows={2} maxLength={MAX_NOTE_CHARS} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={t("wallet.detailsPlaceholder")} />
      </div>

      {merchant && (
        <p className="mt-4 text-xs leading-relaxed text-ink-500">
          {t("wallet.storeNote")}
        </p>
      )}
    </Sheet>
  );
}
