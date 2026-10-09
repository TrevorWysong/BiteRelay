import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Minus, Plus, Trash2, ArrowLeft } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { Button, Card, Checkbox, Input, Select, StatNumber, Textarea } from "../../components/ui";
import { AddressSwitcher } from "../../components/AddressSwitcher";
import { distanceKm } from "../../lib/geohash";
import { useCart, cartItems, expandLineQuantities, type CartLine } from "../../store/cart";
import { useSession } from "../../store/session";
import { requestDelivery, requestPickupOrder, createRecurringTemplate, countMyCompletedOrders } from "../../holochain/zomes/dispatch";
import { getCatalog, listLivePromoCodes } from "../../holochain/zomes/catalog";
import { actionHash, bytesToHex, decodeEntry } from "../../holochain/decode";
import { formatCents } from "../../lib/format";
import { computePromoEffect, describeRequirement, describeReward, evaluatePromo, isPromoEligible } from "../../lib/promotions";
import { fetchMenu } from "../../lib/menu";
import { WEEKDAYS } from "../../lib/recurrence";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import { describeError } from "../../lib/errors";
import { useResource } from "../../lib/useResource";
import type { ActionHash, DropoffPreference, GeoPoint, MenuItem, MerchantCatalog, PromoCode, RecurrenceRule } from "../../holochain/types";

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

// Client-side pre-check only -- `request_delivery`'s own coordinator-level
// check (dispatch_coordinator::orders, same best-effort trust tier as its
// promo-code/bag-claim checks) is the real enforcement. `null` for
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
const NO_ITEMS: { hash: ActionHash; item: MenuItem }[] = [];

interface CartStoreInfo {
  subsidyPercent: number;
  // Merchant's own delivery-range setting -- lets `onValidate` below
  // reject an out-of-range dropoff pick client-side, before the order is
  // even submitted. The real, authoritative enforcement is still
  // `request_delivery`'s own coordinator-level check; this is purely a
  // faster, friendlier pre-check -- `null` until the catalog loads, which
  // `onValidate` treats as "nothing to check yet".
  merchantLocation: GeoPoint | null;
  merchantRadiusKm: number | null;
  promoCodes: PromoRow[];
  menuItems: { hash: ActionHash; item: MenuItem }[];
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
  const catalogRef = cart.catalogRef;
  const { data: storeInfo } = useResource(catalogRef && `cart-store:${bytesToHex(catalogRef)}`, () => fetchCartStoreInfo(catalogRef!));
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
  const estimatedTotalCents = discountedSubtotalCents + tipCents + customerFeeShareCents;

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
      if (fulfillment === "Pickup") {
        const record = await requestPickupOrder({
          merchant: cart.merchant,
          catalog_ref: cart.catalogRef,
          items: cartItems(cart.lines),
          order_total: discountedSubtotalCents,
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
        order_total: discountedSubtotalCents,
        dropoff,
        max_delivery_fee: maxFeeCents,
        kitchen_notes: kitchenNotes.trim(),
        dropoff_notes: dropoffNotes.trim(),
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
        item_refs: expandLineQuantities(cart.lines),
        dropoff,
        max_delivery_fee: maxFeeCents,
        kitchen_notes: kitchenNotes.trim(),
        dropoff_notes: dropoffNotes.trim(),
        tip_cents: tipCents,
        dropoff_preference: dropoffPreference,
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
            const key = bytesToHex(line.itemRef);
            return (
              <div key={key} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{line.name}</p>
                  <p className="text-xs text-ink-400">{formatCents(line.priceCents)} each</p>
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
            {DROPOFF_PREFERENCE_OPTIONS.map(({ value, label }) => (
              <ToggleChip key={value} active={dropoffPreference === value} onClick={() => setDropoffPreference(value)} className="flex-1">
                {label}
              </ToggleChip>
            ))}
          </div>
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
        <Textarea value={kitchenNotes} onChange={(e) => setKitchenNotes(e.target.value)} rows={2} placeholder="No onions, extra napkins…" />
      </Section>

      {fulfillment === "Delivery" && (
        <Section title="Drop-off instructions">
          <Textarea value={dropoffNotes} onChange={(e) => setDropoffNotes(e.target.value)} rows={2} placeholder="Leave at the door, gate code, etc." />
          <p className="mt-1.5 text-[11px] text-ink-400">Only your driver sees your exact address and these instructions, once you've accepted their bid.</p>
        </Section>
      )}

      {fulfillment === "Delivery" && (
        <Section title="Delivery fee cap">
          <p className="mb-2 text-xs text-ink-400">Drivers bid to deliver your order, up to this amount. You're only ever charged what the winning bid actually offers, never more.</p>
          <div className="flex flex-wrap gap-2">
            {DELIVERY_FEE_PRESETS_CENTS.map((cents) => (
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
              prefix="$"
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
              prefix="$"
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
              <Input value={promoInput} onChange={(e) => setPromoInput(e.target.value)} placeholder="Enter code" className="flex-1 font-mono" />
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
            <StatNumber className="text-lg">{formatCents(fulfillment === "Pickup" ? discountedSubtotalCents : estimatedTotalCents)}</StatNumber>
          </div>
        </Card>
      </motion.div>

      <motion.div variants={fadeSlideUp} className="mt-4 rounded-2xl bg-ink-100/60 dark:bg-ink-800/60 p-4 text-xs text-ink-500 dark:text-ink-400">
        {fulfillment === "Pickup"
          ? "The merchant will confirm your order and let you know when it's ready to collect."
          : "Placing this order notifies nearby drivers directly. If nobody picks it up right away, it stays visible until one does."}
      </motion.div>

      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}

      <div className="fixed inset-x-0 bottom-20 z-20 mx-auto flex max-w-md justify-center px-4">
        <Button
          className="w-full"
          loading={placing}
          disabled={fulfillment === "Delivery" && (maxFeeCents <= 0 || scheduleInvalid)}
          onClick={placeOrder}
        >
          {fulfillment === "Pickup" ? "Place pickup order" : scheduled ? "Schedule order" : "Place order"} ·{" "}
          {fulfillment === "Pickup" ? formatCents(discountedSubtotalCents) : `up to ${formatCents(estimatedTotalCents)}`}
        </Button>
      </div>
    </motion.div>
  );
}
