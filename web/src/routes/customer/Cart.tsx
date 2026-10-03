import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Minus, Plus, Trash2, ArrowLeft } from "lucide-react";
import { Button } from "../../components/ui";
import { LocationInput } from "../../components/LocationInput";
import { useCart } from "../../store/cart";
import { useSession } from "../../store/session";
import { requestDelivery, createRecurringTemplate, getOrdersForRequester } from "../../holochain/zomes/dispatch";
import { getCatalog, listMenuItems, listPromoCodesForCatalog } from "../../holochain/zomes/catalog";
import { actionHash, bytesEqual, bytesToHex, decodeEntry } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import { formatCents } from "../../lib/format";
import { computePromoEffect, describeRequirement, describeReward, evaluatePromo, isPromoEligible } from "../../lib/promotions";
import { nextOccurrence, toMicros, WEEKDAYS } from "../../lib/recurrence";
import type { ActionHash, DeliveryOrder, DropoffPreference, GeoPoint, MenuItem, MerchantCatalog, PromoCode, RecurrenceRule } from "../../holochain/types";

const TIP_PRESETS_PERCENT = [0, 10, 15, 20];
const DROPOFF_PREFERENCE_OPTIONS: { value: DropoffPreference; label: string }[] = [
  { value: "LeaveAtDoor", label: "Leave at door" },
  { value: "HandToMe", label: "Hand to me" },
  { value: "MeetOutside", label: "Meet outside" },
];
// A driver's bid can be anywhere up to this cap (validate_new_bid rejects
// anything higher) -- letting the customer set it, rather than hardcoding
// `max_delivery_fee: null`, is what actually gives them cost certainty at
// checkout instead of an unbounded "set by driver bid" placeholder.
const DELIVERY_FEE_PRESETS_CENTS = [400, 600, 900, 1200];

export function Cart() {
  const cart = useCart();
  const location = useSession((s) => s.location);
  const setSessionLocation = useSession((s) => s.setLocation);
  const navigate = useNavigate();
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  // Defaults to the session's saved location, but editable per order --
  // previously frozen at whatever was set once during onboarding, with no
  // way to deliver anywhere else (e.g. a friend's place) or update it after
  // moving.
  const [dropoff, setDropoff] = useState<GeoPoint>(location);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [dropoffPreference, setDropoffPreference] = useState<DropoffPreference>("LeaveAtDoor");
  const [showRecurring, setShowRecurring] = useState(false);
  const [recurrenceKind, setRecurrenceKind] = useState<"Daily" | "Weekly">("Weekly");
  const [recurrenceWeekday, setRecurrenceWeekday] = useState(1); // Monday
  const [recurrenceTime, setRecurrenceTime] = useState("09:00");
  const [savingRecurring, setSavingRecurring] = useState(false);
  const [recurringSaved, setRecurringSaved] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");
  const [tipPercent, setTipPercent] = useState<number | null>(15);
  const [customTip, setCustomTip] = useState("");
  const [feePreset, setFeePreset] = useState<number | null>(DELIVERY_FEE_PRESETS_CENTS[1]);
  const [customFee, setCustomFee] = useState("");
  const [subsidyPercent, setSubsidyPercent] = useState(0);
  const [promoCodes, setPromoCodes] = useState<{ hash: ActionHash; promo: PromoCode }[]>([]);
  const [menuItems, setMenuItems] = useState<{ hash: ActionHash; item: MenuItem }[]>([]);
  const [promoInput, setPromoInput] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<{ hash: ActionHash; promo: PromoCode } | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [completedOrderCount, setCompletedOrderCount] = useState(0);

  useEffect(() => {
    if (!cart.catalogRef) return;
    getCatalog(cart.catalogRef)
      .then((record) => setSubsidyPercent(decodeEntry<MerchantCatalog>(record).delivery_subsidy_percent))
      .catch(() => setSubsidyPercent(0));
    listPromoCodesForCatalog(cart.catalogRef)
      .then((records) => setPromoCodes(records.map((r) => ({ hash: actionHash(r), promo: decodeEntry<PromoCode>(r) }))))
      .catch(() => setPromoCodes([]));
    // Needed to describe/evaluate item-scoped requirements and rewards
    // (BOGO, "spend $X get item Y free") even when the item they name isn't
    // already sitting in the cart -- cart lines alone can't resolve a
    // reward item's name if the customer hasn't added it yet.
    listMenuItems({ catalog_ref: cart.catalogRef, after: null })
      .then((page) => setMenuItems(page.items.map((r) => ({ hash: actionHash(r), item: decodeEntry<MenuItem>(r) }))))
      .catch(() => setMenuItems([]));
    // Loyalty rewards ("order 5 times, your 6th is discounted") need this
    // customer's own completed-order count at *this* merchant -- their own
    // RequesterToOrder links, a purely local, agent-centric read, same
    // category as the no-skim dashboard's own personal ledger.
    getOrdersForRequester(myAgentPubKey())
      .then((records) => {
        const count = records.filter((r) => {
          const o = decodeEntry<DeliveryOrder>(r);
          return o.status === "Delivered" && bytesEqual(o.catalog_ref, cart.catalogRef!);
        }).length;
        setCompletedOrderCount(count);
      })
      .catch(() => setCompletedOrderCount(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-apply: once promo codes and the loyalty count are both known, the
  // best *eligible, auto_apply* code gets applied without the customer
  // typing anything -- but only if they haven't already applied a
  // (manually typed) code of their own, which always wins.
  useEffect(() => {
    if (appliedPromo || promoCodes.length === 0) return;
    const now = Date.now() * 1000;
    const eligibleAutoApply = promoCodes.filter(
      (p) =>
        p.promo.auto_apply &&
        p.promo.active &&
        (p.promo.expires_at === null || p.promo.expires_at > now) &&
        isPromoEligible(p.promo.requirement, cart.lines, cart.total(), completedOrderCount),
    );
    if (eligibleAutoApply.length === 0) return;
    const best = eligibleAutoApply.reduce((a, b) =>
      computePromoEffect(b.promo.reward, cart.lines, cart.total()).subtotalDiscountCents >
      computePromoEffect(a.promo.reward, cart.lines, cart.total()).subtotalDiscountCents
        ? b
        : a,
    );
    setAppliedPromo(best);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoCodes, completedOrderCount]);

  const itemName = (hex: string) => menuItems.find((m) => bytesToHex(m.hash) === hex)?.item.name;

  function applyPromo() {
    setPromoError(null);
    const typed = promoInput.trim().toUpperCase();
    const now = Date.now() * 1000;
    const match = promoCodes.find((p) => p.promo.code.toUpperCase() === typed && p.promo.active && (p.promo.expires_at === null || p.promo.expires_at > now));
    if (!match) {
      setPromoError("That code isn't valid or has expired.");
      return;
    }
    if (!isPromoEligible(match.promo.requirement, cart.lines, cart.total(), completedOrderCount)) {
      setPromoError(`Not eligible yet -- ${describeRequirement(match.promo.requirement, itemName).toLowerCase()} to use this code.`);
      return;
    }
    setAppliedPromo(match);
  }

  const tipCents = tipPercent !== null ? Math.round((cart.total() * tipPercent) / 100) : Math.round(Number(customTip || 0) * 100);
  const maxFeeCents = feePreset !== null ? feePreset : Math.round(Number(customFee || 0) * 100);
  // Worst case (a winning bid right at the cap): mirrors the settlement
  // formula in dispatch::settle_delivery_fee exactly (architecture plan
  // §12) -- merchant_share floor-rounded, customer absorbs the remainder.
  const customerFeeShareCents = maxFeeCents - Math.floor((maxFeeCents * subsidyPercent) / 100);
  // Re-evaluated against the *current* cart every render, not just at the
  // moment the code was applied -- a requirement can stop being met (e.g.
  // the qualifying item gets removed) or a reward can newly become
  // redeemable (e.g. a "spend $X get item Y free" code applied before Y was
  // added), and the summary should reflect that live, not the stale state
  // from when "Apply" was clicked.
  const promoEvaluation = appliedPromo ? evaluatePromo(appliedPromo.promo, cart.lines, cart.total(), completedOrderCount) : null;
  const promoDiscountCents = promoEvaluation?.effect.subtotalDiscountCents ?? 0;
  const promoRewardNeedsItem = appliedPromo ? "FreeItem" in appliedPromo.promo.reward || "PercentOffItem" in appliedPromo.promo.reward : false;
  const promoAwaitingRewardItem = !!appliedPromo && !!promoEvaluation?.eligible && promoRewardNeedsItem && promoEvaluation.effect.itemEffects.length === 0;
  const discountedSubtotalCents = cart.total() - promoDiscountCents;

  if (cart.lines.length === 0) {
    return (
      <div className="px-6 py-20 text-center">
        <p className="text-sm text-ink-400">Your cart is empty.</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate("/customer")}>
          Browse restaurants
        </Button>
      </div>
    );
  }

  // Holochain Timestamps are microseconds since epoch; <input type=
  // "datetime-local"> gives a local-time string with no timezone info --
  // Date.parse treats it as local time already, matching what the customer
  // actually picked, so no further conversion is needed beyond ms -> µs.
  const requestedDeliveryTime = scheduled && scheduledFor ? Date.parse(scheduledFor) * 1000 : null;
  const scheduleInvalid = scheduled && (!scheduledFor || (requestedDeliveryTime !== null && requestedDeliveryTime <= Date.now() * 1000));

  async function placeOrder() {
    if (!cart.catalogRef || !cart.merchant) return;
    setPlacing(true);
    setError(null);
    try {
      const record = await requestDelivery({
        merchant: cart.merchant,
        catalog_ref: cart.catalogRef,
        // Repeated per quantity, not deduplicated -- item_refs is a plain
        // Vec<ActionHash> with no parallel quantity field, so "2x Burger"
        // is represented as the same ref appearing twice. Nothing reads
        // item_refs as a set (dispatch_integrity only checks non-emptiness
        // and byte-identical-on-update), so this is a safe, no-backend-
        // change way to stop silently dropping quantity at checkout.
        item_refs: cart.lines.flatMap((l) => Array(l.quantity).fill(l.itemRef)),
        order_total: discountedSubtotalCents,
        dropoff,
        max_delivery_fee: maxFeeCents,
        special_instructions: instructions.trim(),
        tip_cents: tipCents,
        requested_delivery_time: requestedDeliveryTime,
        promo_code_ref: appliedPromo?.hash ?? null,
        dropoff_preference: dropoffPreference,
      });
      const orderRef = actionHash(record);
      if (saveAsDefault) setSessionLocation(dropoff);
      cart.clear();
      navigate(`/customer/orders/${bytesToHex(orderRef)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlacing(false);
    }
  }

  async function saveRecurring() {
    if (!cart.catalogRef || !cart.merchant) return;
    setSavingRecurring(true);
    setError(null);
    try {
      const recurrence: RecurrenceRule =
        recurrenceKind === "Daily"
          ? { Daily: { hour: Number(recurrenceTime.split(":")[0]), minute: Number(recurrenceTime.split(":")[1]) } }
          : { Weekly: { weekday: recurrenceWeekday, hour: Number(recurrenceTime.split(":")[0]), minute: Number(recurrenceTime.split(":")[1]) } };
      await createRecurringTemplate({
        merchant: cart.merchant,
        catalog_ref: cart.catalogRef,
        item_refs: cart.lines.flatMap((l) => Array(l.quantity).fill(l.itemRef)),
        dropoff,
        max_delivery_fee: maxFeeCents,
        special_instructions: instructions.trim(),
        tip_cents: tipCents,
        dropoff_preference: dropoffPreference,
        promo_code_ref: appliedPromo?.hash ?? null,
        recurrence,
        next_run_at: toMicros(nextOccurrence(recurrence)),
      });
      setRecurringSaved(true);
      setShowRecurring(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRecurring(false);
    }
  }

  return (
    <div className="px-4 pb-28 pt-4">
      <button onClick={() => navigate(-1)} className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-500">
        <ArrowLeft size={16} /> Back
      </button>
      <h1 className="text-xl font-black text-ink-900 dark:text-ink-50">Your order</h1>
      <p className="mb-4 text-xs text-ink-400">from {cart.merchantName}</p>

      <div className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900">
        {cart.lines.map((line) => {
          const key = bytesToHex(line.itemRef);
          return (
            <div key={key} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{line.name}</p>
                <p className="text-xs text-ink-400">{formatCents(line.priceCents)} each</p>
              </div>
              <div className="flex items-center gap-2 rounded-full bg-ink-100 dark:bg-ink-800 px-1.5 py-1">
                <button onClick={() => cart.setQuantity(key, line.quantity - 1)} className="grid h-6 w-6 place-items-center rounded-full hover:bg-ink-200 dark:hover:bg-ink-700">
                  {line.quantity === 1 ? <Trash2 size={14} className="text-ink-400" /> : <Minus size={14} className="text-ink-400" />}
                </button>
                <span className="w-4 text-center text-sm font-semibold">{line.quantity}</span>
                <button onClick={() => cart.setQuantity(key, line.quantity + 1)} className="grid h-6 w-6 place-items-center rounded-full hover:bg-ink-200 dark:hover:bg-ink-700">
                  <Plus size={14} className="text-ink-400" />
                </button>
              </div>
              <span className="w-16 text-right text-sm font-bold">{formatCents(line.priceCents * line.quantity)}</span>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
        <LocationInput value={dropoff} onChange={setDropoff} />
        <label className="mt-2 flex items-center gap-2 text-xs text-ink-400">
          <input type="checkbox" checked={saveAsDefault} onChange={(e) => setSaveAsDefault(e.target.checked)} />
          Save as my default location
        </label>
        <p className="mb-2 mt-3 text-xs font-bold uppercase tracking-wide text-ink-400">Drop-off</p>
        <div className="flex gap-2">
          {DROPOFF_PREFERENCE_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setDropoffPreference(value)}
              className={`flex-1 rounded-full px-2 py-1.5 text-xs font-semibold ${dropoffPreference === value ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">When</p>
        <div className="mb-2 flex gap-2">
          <button
            onClick={() => setScheduled(false)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${!scheduled ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"}`}
          >
            Now
          </button>
          <button
            onClick={() => setScheduled(true)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${scheduled ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"}`}
          >
            Schedule for later
          </button>
        </div>
        {scheduled && (
          <>
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              className="w-full rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
            />
            <p className="mt-1 text-xs text-ink-400">
              No driver matching starts until this time -- your Orders screen will show a button to open it for bids once it arrives (there's no
              server-side scheduler here, it runs from your own client).
            </p>
          </>
        )}
      </div>

      <div className="mt-4 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-400">Repeat this order</p>
          <button onClick={() => setShowRecurring((v) => !v)} className="text-xs font-semibold text-relay-600">
            {showRecurring ? "Cancel" : recurringSaved ? "Edit" : "Set up"}
          </button>
        </div>
        {recurringSaved && !showRecurring && (
          <p className="mt-1 text-xs text-presence-600">Saved -- manage it from your Orders screen.</p>
        )}
        {showRecurring && (
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                onClick={() => setRecurrenceKind("Weekly")}
                className={`flex-1 rounded-full px-3 py-1.5 text-xs font-semibold ${recurrenceKind === "Weekly" ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"}`}
              >
                Weekly
              </button>
              <button
                onClick={() => setRecurrenceKind("Daily")}
                className={`flex-1 rounded-full px-3 py-1.5 text-xs font-semibold ${recurrenceKind === "Daily" ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"}`}
              >
                Daily
              </button>
            </div>
            {recurrenceKind === "Weekly" && (
              <select
                value={recurrenceWeekday}
                onChange={(e) => setRecurrenceWeekday(Number(e.target.value))}
                className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm"
              >
                {WEEKDAYS.map((day, i) => (
                  <option key={day} value={i}>
                    {day}
                  </option>
                ))}
              </select>
            )}
            <input
              type="time"
              value={recurrenceTime}
              onChange={(e) => setRecurrenceTime(e.target.value)}
              className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm"
            />
            <p className="text-xs text-ink-400">
              Fires from your own device while the app is open -- there's no server-side scheduler. Items are re-matched
              against the merchant's current menu each time, best-effort, same as reordering.
            </p>
            <Button loading={savingRecurring} onClick={saveRecurring} className="py-2 text-xs">
              Save recurring order
            </Button>
          </div>
        )}
      </div>

      <div className="mt-4 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">Delivery notes</p>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={2}
          placeholder="Leave at the door, gate code, etc."
          className="w-full resize-none rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
        />
      </div>

      <div className="mt-4 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
        <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">Delivery fee cap</p>
        <p className="mb-2 text-xs text-ink-400">Drivers bid to deliver your order, up to this amount — you're only ever charged what the winning bid actually offers, never more.</p>
        <div className="flex flex-wrap gap-2">
          {DELIVERY_FEE_PRESETS_CENTS.map((cents) => (
            <button
              key={cents}
              onClick={() => {
                setFeePreset(cents);
                setCustomFee("");
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${feePreset === cents ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"}`}
            >
              {formatCents(cents)}
            </button>
          ))}
          <input
            type="number"
            min={0}
            step={0.5}
            value={customFee}
            onChange={(e) => {
              setCustomFee(e.target.value);
              setFeePreset(null);
            }}
            placeholder="Custom $"
            className="w-24 rounded-full border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-relay-400"
          />
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">Tip your driver</p>
        <div className="flex flex-wrap gap-2">
          {TIP_PRESETS_PERCENT.map((p) => (
            <button
              key={p}
              onClick={() => {
                setTipPercent(p);
                setCustomTip("");
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${tipPercent === p ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"}`}
            >
              {p === 0 ? "No tip" : `${p}%`}
            </button>
          ))}
          <input
            type="number"
            min={0}
            step={0.5}
            value={customTip}
            onChange={(e) => {
              setCustomTip(e.target.value);
              setTipPercent(null);
            }}
            placeholder="Custom $"
            className="w-24 rounded-full border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-relay-400"
          />
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">Promo code</p>
        {appliedPromo ? (
          <div className="rounded-lg bg-presence-500/10 px-3 py-2 text-sm text-presence-600 dark:text-presence-400">
            <div className="flex items-center justify-between">
              <span className="font-mono font-semibold">
                {appliedPromo.promo.auto_apply && <span className="mr-1.5 rounded-full bg-presence-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">🎁 Loyalty</span>}
                {appliedPromo.promo.code}
              </span>
              <button
                onClick={() => {
                  setAppliedPromo(null);
                  setPromoInput("");
                }}
                className="text-xs underline"
              >
                Remove
              </button>
            </div>
            <p className="mt-0.5 text-xs opacity-80">{describeReward(appliedPromo.promo.reward, itemName)}</p>
            {!promoEvaluation?.eligible && <p className="mt-1 text-xs text-red-600">No longer eligible -- {describeRequirement(appliedPromo.promo.requirement, itemName).toLowerCase()}.</p>}
            {promoAwaitingRewardItem && <p className="mt-1 text-xs text-amber-600">Add the qualifying item to your cart to redeem this.</p>}
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              value={promoInput}
              onChange={(e) => setPromoInput(e.target.value)}
              placeholder="Enter code"
              className="flex-1 rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm font-mono outline-none focus:border-relay-400"
            />
            <Button variant="ghost" className="px-4 py-2 text-xs" onClick={applyPromo}>
              Apply
            </Button>
          </div>
        )}
        {promoError && <p className="mt-1 text-xs text-red-600">{promoError}</p>}
      </div>

      <div className="mt-4 flex flex-col gap-1.5 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4 text-sm">
        <div className="flex justify-between text-ink-400">
          <span>Subtotal</span>
          <span>{formatCents(cart.total())}</span>
        </div>
        {appliedPromo && (
          <div className="flex justify-between text-presence-600 dark:text-presence-400">
            <span>Promo ({appliedPromo.promo.code})</span>
            <span>-{formatCents(promoDiscountCents)}</span>
          </div>
        )}
        <div className="flex justify-between text-ink-400">
          <span>Delivery fee{subsidyPercent > 0 && <span className="text-presence-600"> (merchant covers {subsidyPercent}%)</span>}</span>
          <span>up to {formatCents(customerFeeShareCents)}</span>
        </div>
        <div className="flex justify-between text-ink-400">
          <span>Tip</span>
          <span>{formatCents(tipCents)}</span>
        </div>
        <div className="mt-1 flex justify-between border-t border-ink-100 dark:border-ink-800 pt-2 text-base font-bold text-ink-900 dark:text-ink-50">
          <span>Estimated total</span>
          <span>up to {formatCents(discountedSubtotalCents + tipCents + customerFeeShareCents)}</span>
        </div>
      </div>

      <div className="mt-4 rounded-2xl bg-ink-100/60 dark:bg-ink-800/60 p-4 text-xs text-ink-500 dark:text-ink-400">
        Placing this order publishes it to your local geohash cell — nearby drivers are notified directly, with a background poll
        as a backstop in case the direct notification doesn't land (it's fire-and-forget by design; see HOLOCHAIN_ISSUES.md #1).
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}

      <div className="fixed inset-x-0 bottom-20 z-20 mx-auto flex max-w-md justify-center px-4">
        <Button className="w-full" loading={placing} disabled={maxFeeCents <= 0 || scheduleInvalid} onClick={placeOrder}>
          {scheduled ? "Schedule order" : "Place order"} · up to {formatCents(discountedSubtotalCents + tipCents + customerFeeShareCents)}
        </Button>
      </div>
    </div>
  );
}
