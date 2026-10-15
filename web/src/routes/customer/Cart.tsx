import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Minus, Plus, Trash2, ArrowLeft } from "lucide-react";
import { InfoTip } from "../../components/InfoTip";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { Button, Card, Checkbox, Input, Select, StatNumber, Textarea } from "../../components/ui";
import { AddressSwitcher } from "../../components/AddressSwitcher";
import { distanceKm } from "../../lib/geohash";
import { useCart, cartItems, lineKey, type CartLine } from "../../store/cart";
import { ItemSheet } from "../../components/ItemSheet";
import { useSession } from "../../store/session";
import { requestDelivery, requestPickupOrder, createRecurringTemplate, countMyCompletedOrders } from "../../holochain/zomes/dispatch";
import { getCatalog, listLivePromoCodes } from "../../holochain/zomes/catalog";
import { actionHash, bytesToHex, decodeEntry } from "../../holochain/decode";
import { formatCents, toMinorUnits, fromMinorUnits, currencySymbol } from "../../lib/format";
import { useCustomerSettings } from "../../store/roleSettings";
import { useTerms } from "../../store/network";
import { computePromoEffect, describeRequirement, describeReward, evaluatePromo, isPromoEligible } from "../../lib/promotions";
import { fetchMenu, type ItemRow } from "../../lib/menu";
import { WEEKDAYS } from "../../lib/recurrence";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import { describeError } from "../../lib/errors";
import { useResource } from "../../lib/useResource";
import { POLL } from "../../lib/poll";
import { orderTax, totalWithTax } from "../../lib/tax";
import { CardPaySheet } from "../../components/CardPaySheet";
import { isPayable, MAX_CARD_PAYMENT_CENTS, MIN_CARD_PAYMENT_CENTS } from "../../lib/issuerService";
import { getBalance, listIssuers } from "../../holochain/zomes/ledger";
import type { ActionHash, DropoffPreference, GeoPoint, MerchantCatalog, PromoCode, RecurrenceRule, TaxRate } from "../../holochain/types";
import { useClock } from "../../lib/useClock";
import { storeStatus } from "../../lib/storeHours";
import { MAX_NOTE_CHARS, MAX_PROMO_CODE_CHARS } from "../../holochain/types";

const TIP_PRESETS_PERCENT = [0, 10, 15, 20];
const DROPOFF_PREFERENCE_OPTIONS: { value: DropoffPreference; label: string }[] = [
  { value: "HandToMe", label: "Hand to me" },
  { value: "MeetOutside", label: "Meet outside" },
  { value: "LeaveAtDoor", label: "Leave at door" },
];
// A driver's bid can be anywhere up to this cap (validate_new_bid rejects
// anything higher) -- letting the customer set it, rather than hardcoding
// `max_delivery_fee: null`, is what actually gives them cost certainty at
// checkout instead of an unbounded "set by driver bid" placeholder.

/// How a delivery is driven: standard, or priority -- a driver with no
/// other orders (`DeliveryOrder::priority`).
const DELIVERY_SPEEDS = [
  { priority: false, label: "Standard", detail: "Your driver may pick up another order on the way, as on any delivery app." },
  { priority: true, label: "Priority", detail: "A driver with no other orders brings yours straight to you. Drivers usually bid more for it." },
];

/// Who picks the driver: the app, by the network's published rule, or the
/// customer.
const MATCHING = [
  { autoMatch: true, label: "Pick for me", detail: "Your app takes the best bid shortly after the first arrives: the lowest fee, counting time and each driver's record. You can still pick one yourself first." },
  { autoMatch: false, label: "I'll choose", detail: "You see every bid, with each driver's record, and accept one yourself." },
];

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <motion.div variants={fadeSlideUp}>
      <Card className="mt-4 p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-400">{title}</p>
          {right}
        </div>
        {children}
      </Card>
    </motion.div>
  );
}

// A pre-check, so the customer hears it while choosing: the network refuses
// an order outside the radius of the store version it cites. `null` for
// `merchantLocation`/`merchantRadiusKm` (catalog still loading) means
// nothing to check yet, so every pick is allowed rather than blocked on a
// fetch that hasn't resolved.
function validateDropoffRadius(point: GeoPoint, merchantLocation: GeoPoint | null, merchantRadiusKm: number | null): string | null {
  if (!merchantLocation || merchantRadiusKm === null) return null;
  const distance = distanceKm(merchantLocation, point);
  if (distance > merchantRadiusKm) {
    return `That's ${distance.toFixed(1)}km away -- this merchant only delivers within ${merchantRadiusKm}km.`;
  }
  return null;
}

function ToggleChip({ active, onClick, children, className }: { active: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      onClick={onClick}
      className={clsx(
        "rounded-full px-3 py-1.5 text-xs font-semibold transition",
        active ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500 hover:bg-ink-200 dark:hover:bg-ink-700",
        className
      )}
    >
      {children}
    </motion.button>
  );
}

type PromoRow = { hash: ActionHash; promo: PromoCode };
const NO_PROMOS: PromoRow[] = [];
const NO_ITEMS: ItemRow[] = [];

interface CartStoreInfo {
  subsidyPercent: number;
  // The store's delivery range -- lets `onValidate` below reject an
  // out-of-range drop-off as it's picked (the network refuses one anyway).
  // `null` until the catalog loads: nothing to check yet.
  merchantLocation: GeoPoint | null;
  merchantRadiusKm: number | null;
  /// When the store takes orders -- checkout says so up front; the zome
  /// refuses a closed store regardless. `null` until the catalog loads.
  hours: Pick<MerchantCatalog, "is_open" | "weekly_hours" | "time_zone"> | null;
  /// The most an order may cost to be left at the door, if the store sets
  /// a limit -- above it, the option isn't offered.
  leaveAtDoorMaxCents: number | null;
  /// The smallest order the store takes, before promos -- the network
  /// refuses a smaller one.
  minOrderCents: number | null;
  /// Minutes the store is adding to its prep time while it's busy.
  busyExtraMinutes: number;
  /// How long past the ready time the store may keep a driver waiting, if
  /// it sets its own -- else the network's.
  storeWaitMinutes: number | null;
  /// The store's sales tax or VAT -- its own, on its own terms.
  taxRates: TaxRate[];
  pricesIncludeTax: boolean;
  promoCodes: PromoRow[];
  menuItems: ItemRow[];
  completedOrderCount: number;
}

/// Everything the cart needs about the store it's ordering from, read
/// once per store. Each part degrades independently on failure, same as
/// before -- a missing promo list shouldn't block checkout.
async function fetchCartStoreInfo(catalogRef: ActionHash): Promise<CartStoreInfo> {
  const [catalog, promoCodes, menuItems, completedOrderCount] = await Promise.all([
    getCatalog(catalogRef)
      .then((record) => decodeEntry<MerchantCatalog>(record))
      .catch(() => null),
    // Only codes usable right now -- the store's live index, not every
    // code it ever ran.
    listLivePromoCodes(catalogRef)
      .then((views) => views.map((v) => ({ hash: v.original_action, promo: decodeEntry<PromoCode>(v.record) })))
      .catch(() => []),
    // Needed to describe/evaluate item-scoped requirements and rewards
    // (BOGO, "spend $X get item Y free") even when the item they name isn't
    // already sitting in the cart.
    fetchMenu(catalogRef)
      .catch(() => []),
    // Loyalty rewards ("order 5 times, your 6th is discounted") count this
    // customer's completed orders at *this* store, delivery and pickup.
    countMyCompletedOrders(catalogRef).catch(() => 0),
  ]);
  return {
    subsidyPercent: catalog?.delivery_subsidy_percent ?? 0,
    merchantLocation: catalog?.location ?? null,
    merchantRadiusKm: catalog?.max_delivery_radius_km ?? null,
    hours: catalog,
    leaveAtDoorMaxCents: catalog?.leave_at_door_max_cents ?? null,
    minOrderCents: catalog?.min_order_cents ?? null,
    busyExtraMinutes: catalog?.busy_extra_minutes ?? 0,
    storeWaitMinutes: catalog?.store_wait_minutes ?? null,
    taxRates: catalog?.tax_rates ?? [],
    pricesIncludeTax: catalog?.prices_include_tax ?? false,
    promoCodes,
    menuItems,
    completedOrderCount,
  };
}

/// The best currently-eligible auto-apply promo for this cart, or `null`.
function bestAutoApplyPromo(promoCodes: PromoRow[], lines: CartLine[], total: number, completedOrderCount: number): PromoRow | null {
  const now = Date.now() * 1000;
  const eligible = promoCodes.filter(
    (p) =>
      p.promo.auto_apply &&
      p.promo.active &&
      (p.promo.expires_at === null || p.promo.expires_at > now) &&
      isPromoEligible(p.promo.requirement, lines, total, completedOrderCount),
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((a, b) =>
    computePromoEffect(b.promo.reward, lines, total).subtotalDiscountCents > computePromoEffect(a.promo.reward, lines, total).subtotalDiscountCents ? b : a,
  );
}

export function Cart() {
  const cart = useCart();
  const location = useSession((s) => s.location);
  const setSessionLocation = useSession((s) => s.setLocation);
  const navigate = useNavigate();
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two notes, each readable only by who it's for: the store (sealed to
  // it) and, for a delivery, the driver (sealed with the address).
  const [kitchenNotes, setKitchenNotes] = useState("");
  const [dropoffNotes, setDropoffNotes] = useState("");
  // Pickup orders skip the whole driver/dropoff/fee/tip half of this screen
  // entirely -- there's no driver in that vertical at all, see
  // `PickupOrder`'s own doc comment (`dispatch_integrity`) for why that's a
  // separate entry type, not a flag on this same order.
  const [fulfillment, setFulfillment] = useState<"Delivery" | "Pickup">("Delivery");
  // Defaults to the session's saved location, but editable per order --
  // previously frozen at whatever was set once during onboarding, with no
  // way to deliver anywhere else (e.g. a friend's place) or update it after
  // moving.
  const [dropoff, setDropoff] = useState<GeoPoint>(location);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  // Checkout starts as the customer last left it.
  const [usual] = useState(() => useCustomerSettings.getState().checkout);
  const feePresets = useTerms().suggested_delivery_fees;
  const [chosenPreference, setDropoffPreference] = useState<DropoffPreference>(usual.dropoffPreference);
  // Leaving it at the door means accepting it's delivered once it's left --
  // asked each time it's chosen.
  const [doorRiskAccepted, setDoorRiskAccepted] = useState(false);
  const [showRecurring, setShowRecurring] = useState(false);
  const [recurrenceKind, setRecurrenceKind] = useState<"Daily" | "Weekly">("Weekly");
  const [recurrenceWeekday, setRecurrenceWeekday] = useState(1); // Monday
  const [recurrenceTime, setRecurrenceTime] = useState("09:00");
  const [savingRecurring, setSavingRecurring] = useState(false);
  /// A line whose choices are being changed.
  const [editing, setEditing] = useState<{ key: string; line: CartLine; row: ItemRow } | null>(null);
  const [recurringSaved, setRecurringSaved] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [priority, setPriority] = useState(usual.priority);
  const [autoMatch, setAutoMatch] = useState(usual.autoMatch);
  const [scheduledFor, setScheduledFor] = useState("");
  const [tipPercent, setTipPercent] = useState<number | null>(usual.tipPercent);
  const [customTip, setCustomTip] = useState("");
  const [feePreset, setFeePreset] = useState<number | null>(() => {
    if (usual.feeCapCents !== null && feePresets.includes(usual.feeCapCents)) return usual.feeCapCents;
    if (usual.feeCapCents !== null) return null;
    return feePresets[Math.min(1, feePresets.length - 1)];
  });
  const [customFee, setCustomFee] = useState(() => (usual.feeCapCents !== null && !feePresets.includes(usual.feeCapCents) ? String(fromMinorUnits(usual.feeCapCents)) : ""));
  const catalogRef = cart.catalogRef;
  const now = useClock();
  const { data: storeInfo } = useResource(catalogRef && `cart-store:${bytesToHex(catalogRef)}`, () => fetchCartStoreInfo(catalogRef!));
  // How late the store may run before a driver can leave it paid and the
  // customer cancel for nothing -- its own, or the network's.
  const networkWaitSecs = useTerms().store_wait_secs;
  const creditLimitCents = useTerms().credit_limit_cents;
  // What the order can draw on, and who it can be topped up through by card
  // when that's short.
  const agentPubKey = useSession((s) => s.agentPubKey);
  const { data: balance } = useResource(agentPubKey && `balance:${bytesToHex(agentPubKey)}`, () => getBalance(agentPubKey!), { pollMs: POLL.signalled });
  const { data: payIssuer } = useResource("card-issuer", async () => (await listIssuers()).find(isPayable) ?? null, { pollMs: POLL.slow });
  /// The card payment the order's waiting on, if any.
  const [payingCents, setPayingCents] = useState<number | null>(null);
  const storeWaitMinutes = storeInfo?.storeWaitMinutes ?? Math.round(networkWaitSecs / 60);
  const subsidyPercent = storeInfo?.subsidyPercent ?? 0;
  const merchantLocation = storeInfo?.merchantLocation ?? null;
  const merchantRadiusKm = storeInfo?.merchantRadiusKm ?? null;
  const promoCodes = storeInfo?.promoCodes ?? NO_PROMOS;
  const menuItems = storeInfo?.menuItems ?? NO_ITEMS;
  const completedOrderCount = storeInfo?.completedOrderCount ?? 0;
  const [promoInput, setPromoInput] = useState("");
  // A code the customer typed always wins. Otherwise the best *eligible,
  // auto_apply* code (a loyalty reward, say) applies by itself -- computed
  // from the live cart every render rather than picked once by an effect,
  // so adding/removing items re-evaluates which auto code (if any)
  // currently qualifies. Removing an auto-applied code dismisses auto-apply
  // for this cart visit.
  const [manualPromo, setManualPromo] = useState<PromoRow | null>(null);
  const [autoPromoDismissed, setAutoPromoDismissed] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  const autoPromo = useMemo(
    () => (autoPromoDismissed ? null : bestAutoApplyPromo(promoCodes, cart.lines, cart.total(), completedOrderCount)),
    // cart.lines is the cart's whole content; total() is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [autoPromoDismissed, promoCodes, cart.lines, completedOrderCount],
  );
  const appliedPromo = manualPromo ?? autoPromo;

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
      setPromoError(`Not eligible yet. ${describeRequirement(match.promo.requirement, itemName)} to use this code.`);
      return;
    }
    setManualPromo(match);
  }

  const tipCents = tipPercent !== null ? Math.round((cart.total() * tipPercent) / 100) : toMinorUnits(Number(customTip || 0));
  const maxFeeCents = feePreset !== null ? feePreset : toMinorUnits(Number(customFee || 0));
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
  // The store's tax on the food after any promo, as validation computes it
  // (`lib/tax.ts`): added on top, or already in the prices.
  const taxCategoryOf = (itemRef: Uint8Array) => storeInfo?.menuItems.find((row) => bytesToHex(row.hash) === bytesToHex(itemRef))?.item.tax_category ?? "";
  const taxRates = storeInfo?.taxRates ?? [];
  const taxIncluded = storeInfo?.pricesIncludeTax ?? false;
  const taxCents = orderTax(
    cart.lines.map((line) => ({ category: taxCategoryOf(line.itemRef), total: line.priceCents * line.quantity })),
    discountedSubtotalCents,
    taxRates,
    taxIncluded,
  );
  /// What the store is paid: the food, and its tax.
  const orderTotalCents = totalWithTax(discountedSubtotalCents, taxCents, taxIncluded);
  // The store's limit on what may be left at a door; above it, the order is
  // handed over whatever was chosen.
  // The store's minimum is on the menu prices, before any promo.
  const shortOfMinimum = storeInfo?.minOrderCents != null ? Math.max(0, storeInfo.minOrderCents - cart.total()) : 0;
  const doorAllowed = storeInfo?.leaveAtDoorMaxCents == null || orderTotalCents <= storeInfo.leaveAtDoorMaxCents;
  const dropoffPreference: DropoffPreference = chosenPreference === "LeaveAtDoor" && !doorAllowed ? "HandToMe" : chosenPreference;
  const estimatedTotalCents = orderTotalCents + tipCents + customerFeeShareCents;
  // What placing it sets aside from the balance, which may run down to the
  // network's credit limit; a shortfall is paid by card first -- at least
  // the least a card payment may be.
  const orderHoldCents = fulfillment === "Pickup" ? orderTotalCents : estimatedTotalCents;
  const shortfallCents = balance === undefined ? 0 : Math.max(0, orderHoldCents - (balance + creditLimitCents));
  const cardChargeCents = Math.max(shortfallCents, MIN_CARD_PAYMENT_CENTS);
  const payByCard = shortfallCents > 0 && !!payIssuer && cardChargeCents <= MAX_CARD_PAYMENT_CENTS;

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
  const scheduleInvalid = scheduled && (!scheduledFor || (requestedDeliveryTime !== null && requestedDeliveryTime <= now.getTime() * 1000));
  // Open when the order's for: now, or a scheduled delivery's time. A
  // goodie bag isn't in the cart -- it runs on its own pickup window.
  const orderFor = fulfillment === "Delivery" && requestedDeliveryTime !== null ? new Date(requestedDeliveryTime / 1000) : now;
  const storeHours = storeInfo?.hours ? storeStatus(storeInfo.hours, orderFor) : null;
  const storeClosed = storeHours !== null && !storeHours.open;

  async function placeOrder() {
    if (!cart.catalogRef || !cart.merchant) return;
    setPlacing(true);
    setError(null);
    try {
      if (fulfillment === "Pickup") {
        const record = await requestPickupOrder({
          merchant: cart.merchant,
          catalog_ref: cart.catalogRef,
          items: cartItems(cart.lines),
          order_total: orderTotalCents,
          kitchen_notes: kitchenNotes.trim(),
          promo_code_ref: appliedPromo?.hash ?? null,
        });
        const orderRef = actionHash(record);
        cart.clear();
        navigate(`/customer/pickup-orders/${bytesToHex(orderRef)}`);
        return;
      }
      const record = await requestDelivery({
        merchant: cart.merchant,
        catalog_ref: cart.catalogRef,
        items: cartItems(cart.lines),
        order_total: orderTotalCents,
        dropoff,
        max_delivery_fee: maxFeeCents,
        kitchen_notes: kitchenNotes.trim(),
        dropoff_notes: dropoffNotes.trim(),
        tip_cents: tipCents,
        requested_delivery_time: requestedDeliveryTime,
        promo_code_ref: appliedPromo?.hash ?? null,
        dropoff_preference: dropoffPreference,
        door_risk_accepted: dropoffPreference === "LeaveAtDoor" && doorRiskAccepted,
        priority,
        auto_match: autoMatch,
      });
      const orderRef = actionHash(record);
      useCustomerSettings.getState().rememberCheckout({ tipPercent, feeCapCents: maxFeeCents, dropoffPreference, priority, autoMatch });
      if (saveAsDefault) setSessionLocation(dropoff);
      cart.clear();
      navigate(`/customer/orders/${bytesToHex(orderRef)}`);
    } catch (err) {
      setError(describeError(err));
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
        items: cartItems(cart.lines),
        dropoff,
        max_delivery_fee: maxFeeCents,
        kitchen_notes: kitchenNotes.trim(),
        dropoff_notes: dropoffNotes.trim(),
        tip_cents: tipCents,
        dropoff_preference: dropoffPreference,
        door_risk_accepted: dropoffPreference === "LeaveAtDoor" && doorRiskAccepted,
        priority,
        promo_code_ref: appliedPromo?.hash ?? null,
        recurrence,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setRecurringSaved(true);
      setShowRecurring(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSavingRecurring(false);
    }
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-28 pt-4">
      <motion.button variants={fadeSlideUp} onClick={() => navigate(-1)} className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-500">
        <ArrowLeft size={16} /> Back
      </motion.button>
      <motion.h1 variants={fadeSlideUp} className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        Your order
      </motion.h1>
      <motion.p variants={fadeSlideUp} className="mb-4 text-xs text-ink-400">
        from {cart.merchantName}
      </motion.p>

      <motion.div variants={fadeSlideUp} className="mb-4 flex gap-2">
        <ToggleChip active={fulfillment === "Delivery"} onClick={() => setFulfillment("Delivery")} className="flex-1 text-center">
          Delivery
        </ToggleChip>
        <ToggleChip active={fulfillment === "Pickup"} onClick={() => setFulfillment("Pickup")} className="flex-1 text-center">
          Pickup
        </ToggleChip>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Card className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800">
          {cart.lines.map((line) => {
            const key = lineKey(line);
            const row = line.selections.length > 0 ? menuItems.find((m) => bytesToHex(m.hash) === bytesToHex(line.itemRef)) : undefined;
            return (
              <div key={key} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{line.name}</p>
                  {line.choiceLabels.length > 0 && <p className="line-clamp-2 text-xs text-ink-500 dark:text-ink-400">{line.choiceLabels.join(", ")}</p>}
                  <p className="text-xs text-ink-400">
                    {formatCents(line.priceCents)} each
                    {row && (
                      <button type="button" onClick={() => setEditing({ key, line, row })} className="ml-2 font-semibold text-relay-600 hover:underline dark:text-relay-400">
                        Edit
                      </button>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2 rounded-full bg-ink-100 dark:bg-ink-800 px-1.5 py-1">
                  <motion.button whileTap={{ scale: 0.85 }} onClick={() => cart.setQuantity(key, line.quantity - 1)} className="grid h-6 w-6 place-items-center rounded-full hover:bg-ink-200 dark:hover:bg-ink-700">
                    {line.quantity === 1 ? <Trash2 size={14} className="text-ink-400" /> : <Minus size={14} className="text-ink-400" />}
                  </motion.button>
                  <span className="w-4 text-center text-sm font-semibold">{line.quantity}</span>
                  <motion.button whileTap={{ scale: 0.85 }} onClick={() => cart.setQuantity(key, line.quantity + 1)} className="grid h-6 w-6 place-items-center rounded-full hover:bg-ink-200 dark:hover:bg-ink-700">
                    <Plus size={14} className="text-ink-400" />
                  </motion.button>
                </div>
                <StatNumber className="w-16 text-right text-sm">{formatCents(line.priceCents * line.quantity)}</StatNumber>
              </div>
            );
          })}
        </Card>
      </motion.div>

      {fulfillment === "Delivery" && (
        <Section title="Deliver to">
          <AddressSwitcher
            value={dropoff}
            onChange={setDropoff}
            onValidate={(point) => validateDropoffRadius(point, merchantLocation, merchantRadiusKm)}
            label="Deliver to"
          />
          <label className="mt-2 flex items-center gap-2 text-xs text-ink-400">
            <Checkbox checked={saveAsDefault} onChange={(e) => setSaveAsDefault(e.target.checked)} />
            Save as my default location
          </label>
          <p className="mb-2 mt-3 text-xs font-bold uppercase tracking-wide text-ink-400">Drop-off</p>
          <div className="flex gap-2">
            {DROPOFF_PREFERENCE_OPTIONS.filter(({ value }) => value !== "LeaveAtDoor" || doorAllowed).map(({ value, label }) => (
              <ToggleChip
                key={value}
                active={dropoffPreference === value}
                onClick={() => {
                  setDropoffPreference(value);
                  setDoorRiskAccepted(false);
                }}
                className="flex-1"
              >
                {label}
              </ToggleChip>
            ))}
          </div>
          {dropoffPreference === "LeaveAtDoor" ? (
            <label className="mt-3 flex items-start gap-2.5 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:bg-amber-900/20 dark:text-amber-100">
              <Checkbox checked={doorRiskAccepted} onChange={(e) => setDoorRiskAccepted(e.target.checked)} className="mt-0.5" />
              <span>
                <span className="font-semibold">Your order is delivered once your driver leaves it.</span> They'll photograph where. If it's taken after that, it
                won't be refunded.
              </span>
            </label>
          ) : (
            <p className="mt-2 text-xs text-ink-400">You'll show your driver a code when they hand it over. That's how you both know it reached you.</p>
          )}
          {!doorAllowed && <p className="mt-1 text-xs text-ink-400">This store hands over orders of this size in person.</p>}
        </Section>
      )}

      {fulfillment === "Delivery" && (
        <Section
          title="Delivery"
          right={
            <InfoTip label="If your order runs late">
              <p className="font-semibold text-ink-900 dark:text-ink-50">If it runs late</p>
              <p className="mt-1">
                If this store keeps your driver waiting more than {storeWaitMinutes} minutes past its ready time, the store pays your driver and your order goes to another one. You can then cancel for a full refund.
              </p>
              <p className="mt-1">If no driver comes, you're refunded in full. You never pay for food you didn't get unless you cancel while it's on its way.</p>
            </InfoTip>
          }
        >
          <div className="flex gap-2">
            {DELIVERY_SPEEDS.map(({ priority: value, label }) => (
              <ToggleChip key={label} active={priority === value} onClick={() => setPriority(value)} className="flex-1">
                {label}
              </ToggleChip>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-400">{DELIVERY_SPEEDS.find((speed) => speed.priority === priority)?.detail}</p>
        </Section>
      )}

      {fulfillment === "Delivery" && (
        <Section title="Driver">
          <div className="flex gap-2">
            {MATCHING.map(({ autoMatch: value, label }) => (
              <ToggleChip key={label} active={autoMatch === value} onClick={() => setAutoMatch(value)} className="flex-1">
                {label}
              </ToggleChip>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-400">{MATCHING.find((m) => m.autoMatch === autoMatch)?.detail}</p>
        </Section>
      )}

      {fulfillment === "Delivery" && (
        <Section title="When">
          <div className="mb-2 flex gap-2">
            <ToggleChip active={!scheduled} onClick={() => setScheduled(false)}>
              Now
            </ToggleChip>
            <ToggleChip active={scheduled} onClick={() => setScheduled(true)}>
              Schedule for later
            </ToggleChip>
          </div>
          <AnimatePresence initial={false}>
            {scheduled && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                <Input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
                <p className="mt-1 text-xs text-ink-400">
                  We won't look for a driver until this time. You can open it up early anytime from your Orders screen.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </Section>
      )}

      {fulfillment === "Delivery" && (
        <Section
          title="Repeat this order"
          right={
            <button onClick={() => setShowRecurring((v) => !v)} className="text-xs font-semibold text-relay-600">
              {showRecurring ? "Cancel" : recurringSaved ? "Edit" : "Set up"}
            </button>
          }
        >
          {recurringSaved && !showRecurring && <p className="text-xs text-presence-600">Saved! Manage it from your Orders screen.</p>}
          <AnimatePresence initial={false}>
            {showRecurring && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <ToggleChip active={recurrenceKind === "Weekly"} onClick={() => setRecurrenceKind("Weekly")} className="flex-1">
                    Weekly
                  </ToggleChip>
                  <ToggleChip active={recurrenceKind === "Daily"} onClick={() => setRecurrenceKind("Daily")} className="flex-1">
                    Daily
                  </ToggleChip>
                </div>
                {recurrenceKind === "Weekly" && (
                  <Select value={recurrenceWeekday} onChange={(e) => setRecurrenceWeekday(Number(e.target.value))}>
                    {WEEKDAYS.map((day, i) => (
                      <option key={day} value={i}>
                        {day}
                      </option>
                    ))}
                  </Select>
                )}
                <Input type="time" value={recurrenceTime} onChange={(e) => setRecurrenceTime(e.target.value)} />
                <p className="text-xs text-ink-400">
                  This order will place itself automatically on that schedule while the app is open on your device. We'll match
                  the items against the current menu each time, so prices or availability may change slightly.
                </p>
                <Button loading={savingRecurring} onClick={saveRecurring} className="py-2 text-xs">
                  Save recurring order
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </Section>
      )}

      <Section title="Note for the store">
        <Textarea maxLength={MAX_NOTE_CHARS} value={kitchenNotes} onChange={(e) => setKitchenNotes(e.target.value)} rows={2} placeholder="No onions, extra napkins…" />
      </Section>

      {fulfillment === "Delivery" && (
        <Section title="Drop-off instructions">
          <Textarea maxLength={MAX_NOTE_CHARS} value={dropoffNotes} onChange={(e) => setDropoffNotes(e.target.value)} rows={2} placeholder="Leave at the door, gate code, etc." />
          <p className="mt-1.5 text-[11px] text-ink-400">Only your driver sees your exact address and these instructions, once you've accepted their bid.</p>
        </Section>
      )}

      {fulfillment === "Delivery" && (
        <Section title="Delivery fee cap">
          <p className="mb-2 text-xs text-ink-400">Drivers bid to deliver your order, up to this amount. You're only ever charged what the winning bid actually offers, never more.</p>
          <div className="flex flex-wrap gap-2">
            {feePresets.map((cents) => (
              <ToggleChip
                key={cents}
                active={feePreset === cents}
                onClick={() => {
                  setFeePreset(cents);
                  setCustomFee("");
                }}
              >
                {formatCents(cents)}
              </ToggleChip>
            ))}
            <Input
              type="number"
              min={0}
              step={0.5}
              value={customFee}
              onChange={(e) => {
                setCustomFee(e.target.value);
                setFeePreset(null);
              }}
              placeholder="Custom"
              prefix={currencySymbol()}
              className="w-24 rounded-full py-1.5 text-xs"
            />
          </div>
        </Section>
      )}

      {fulfillment === "Delivery" && (
        <Section title="Tip your driver">
          <div className="flex flex-wrap gap-2">
            {TIP_PRESETS_PERCENT.map((p) => (
              <ToggleChip
                key={p}
                active={tipPercent === p}
                onClick={() => {
                  setTipPercent(p);
                  setCustomTip("");
                }}
              >
                {p === 0 ? "No tip" : `${p}%`}
              </ToggleChip>
            ))}
            <Input
              type="number"
              min={0}
              step={0.5}
              value={customTip}
              onChange={(e) => {
                setCustomTip(e.target.value);
                setTipPercent(null);
              }}
              placeholder="Custom"
              prefix={currencySymbol()}
              className="w-24 rounded-full py-1.5 text-xs"
            />
          </div>
        </Section>
      )}

      <Section title="Promo code">
        <AnimatePresence mode="wait">
          {appliedPromo ? (
            <motion.div
              key="applied"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              className="rounded-lg bg-presence-500/10 px-3 py-2 text-sm text-presence-600 dark:text-presence-400"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono font-semibold">
                  {appliedPromo.promo.auto_apply && <span className="mr-1.5 rounded-full bg-presence-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">🎁 Loyalty</span>}
                  {appliedPromo.promo.code}
                </span>
                <button
                  onClick={() => {
                    if (manualPromo) setManualPromo(null);
                    else setAutoPromoDismissed(true);
                    setPromoInput("");
                  }}
                  className="text-xs underline"
                >
                  Remove
                </button>
              </div>
              <p className="mt-0.5 text-xs opacity-80">{describeReward(appliedPromo.promo.reward, itemName)}</p>
              {!promoEvaluation?.eligible && <p className="mt-1 text-xs text-red-600">No longer eligible. {describeRequirement(appliedPromo.promo.requirement, itemName)}.</p>}
              {promoAwaitingRewardItem && <p className="mt-1 text-xs text-amber-600">Add the qualifying item to your cart to redeem this.</p>}
            </motion.div>
          ) : (
            <motion.div key="unapplied" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex gap-2">
              <Input maxLength={MAX_PROMO_CODE_CHARS} value={promoInput} onChange={(e) => setPromoInput(e.target.value)} placeholder="Enter code" className="flex-1 font-mono" />
              <Button variant="ghost" className="px-4 py-2 text-xs" onClick={applyPromo}>
                Apply
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
        {promoError && <p className="mt-1 text-xs text-red-600">{promoError}</p>}
      </Section>

      <motion.div variants={fadeSlideUp}>
        <Card className="mt-4 flex flex-col gap-1.5 p-4 text-sm">
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
          {taxRates.length > 0 && !taxIncluded && (
            <div className="flex justify-between text-ink-400">
              <span>{taxRates[0].label || "Tax"}</span>
              <span>{formatCents(taxCents)}</span>
            </div>
          )}
          {fulfillment === "Delivery" && (
            <div className="flex justify-between text-ink-400">
              <span>Delivery fee{subsidyPercent > 0 && <span className="text-presence-600"> (merchant covers {subsidyPercent}%)</span>}</span>
              <span>up to {formatCents(customerFeeShareCents)}</span>
            </div>
          )}
          {fulfillment === "Delivery" && (
            <div className="flex justify-between text-ink-400">
              <span>Tip</span>
              <span>{formatCents(tipCents)}</span>
            </div>
          )}
          <div className="mt-1 flex items-center justify-between border-t border-ink-100 dark:border-ink-800 pt-2">
            <span className="font-bold text-ink-900 dark:text-ink-50">Estimated total</span>
            {fulfillment === "Delivery" && <span className="text-ink-400 text-xs mr-1">up to</span>}
            <StatNumber className="text-lg">{formatCents(fulfillment === "Pickup" ? orderTotalCents : estimatedTotalCents)}</StatNumber>
          </div>
          {taxRates.length > 0 && taxIncluded && taxCents > 0 && (
            <p className="text-right text-xs text-ink-400">
              Includes {formatCents(taxCents)} {taxRates[0].label || "tax"}
            </p>
          )}
        </Card>
      </motion.div>

      <motion.div variants={fadeSlideUp} className="mt-4 rounded-2xl bg-ink-100/60 dark:bg-ink-800/60 p-4 text-xs text-ink-500 dark:text-ink-400">
        {fulfillment === "Pickup"
          ? "The merchant will confirm your order and let you know when it's ready to collect."
          : "Placing this order notifies nearby drivers directly. If nobody picks it up right away, it stays visible until one does."}
      </motion.div>

      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}

      <div className="fixed inset-x-0 bottom-20 z-20 mx-auto flex max-w-md flex-col items-center gap-2 px-4">
        {storeInfo && storeInfo.busyExtraMinutes > 0 && (
          <p className="w-full rounded-lg bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-center text-xs font-semibold text-amber-700 dark:text-amber-300">
            The store is busy: orders are taking about {storeInfo.busyExtraMinutes} minutes longer than usual.
          </p>
        )}
        {shortOfMinimum > 0 && storeInfo?.minOrderCents != null && (
          <p className="w-full rounded-lg bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-center text-xs font-semibold text-amber-700 dark:text-amber-300">
            This store's minimum order is {formatCents(storeInfo.minOrderCents)}. Add {formatCents(shortOfMinimum)} more to order.
          </p>
        )}
        {fulfillment === "Delivery" && discountedSubtotalCents === 0 && (
          <p className="w-full rounded-lg bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-center text-xs font-semibold text-amber-700 dark:text-amber-300">
            A free order can't be delivered: your driver answers for what they carry. Choose pickup instead.
          </p>
        )}
        {shortfallCents > 0 && !payByCard && (
          <p className="w-full rounded-lg bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-center text-xs font-semibold text-amber-700 dark:text-amber-300">
            Your balance is {formatCents(shortfallCents)} short for this order. Add funds in your wallet first.
          </p>
        )}
        {storeClosed && (
          <p className="w-full rounded-lg bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-center text-xs font-semibold text-amber-700 dark:text-amber-300">
            {orderFor === now ? storeHours.label : "The store isn't open at that time."}
          </p>
        )}
        <Button
          className="w-full"
          loading={placing}
          disabled={
            storeClosed ||
            shortOfMinimum > 0 ||
            (shortfallCents > 0 && !payByCard) ||
            (fulfillment === "Delivery" && (discountedSubtotalCents === 0 || maxFeeCents <= 0 || scheduleInvalid || (dropoffPreference === "LeaveAtDoor" && !doorRiskAccepted)))
          }
          onClick={payByCard ? () => setPayingCents(cardChargeCents) : placeOrder}
        >
          {payByCard ? (
            <>Pay {formatCents(cardChargeCents)} and {fulfillment === "Delivery" && scheduled ? "schedule" : "place"} order</>
          ) : (
            <>
              {fulfillment === "Pickup" ? "Place pickup order" : scheduled ? "Schedule order" : "Place order"} ·{" "}
              {fulfillment === "Pickup" ? formatCents(orderTotalCents) : `up to ${formatCents(estimatedTotalCents)}`}
            </>
          )}
        </Button>
      </div>

      {payingCents !== null && payIssuer && agentPubKey && (
        <CardPaySheet
          issuer={payIssuer}
          agent={agentPubKey}
          amount={payingCents}
          title={`Pay ${formatCents(payingCents)}`}
          subtitle={
            payingCents > shortfallCents
              ? `What your balance is short, plus a little to reach the ${formatCents(MIN_CARD_PAYMENT_CENTS)} minimum card payment -- the rest stays in your balance. Your order is placed as soon as it's paid.`
              : "What your balance is short. Your order is placed as soon as it's paid."
          }
          onClose={() => setPayingCents(null)}
          onPaid={async () => {
            setPayingCents(null);
            await placeOrder();
          }}
        />
      )}

      {editing && cart.catalogRef && (
        <ItemSheet
          key={editing.key}
          catalogRef={cart.catalogRef}
          row={editing.row}
          editing={editing.line}
          onClose={() => setEditing(null)}
          onDone={(line) => {
            cart.replaceLine(editing.key, line);
            setEditing(null);
          }}
        />
      )}
    </motion.div>
  );
}
