// Generic promo-code evaluation, mirroring the Rust side's
// `PromoRequirement`/`PromoReward` split (itself grounded in how DoorDash's
// own Promotion Management API separates `purchase_criteria` from
// `discount_options` -- see architecture plan §13 for the research this is
// based on). A plain percent/flat-off code, a "spend $X get item Y free"
// deal, and a buy-X-get-Y-free (BOGO) deal are all just one requirement
// variant paired with one reward variant -- nothing here branches on "which
// promo type is this," so a new requirement or reward shape later is a new
// `case`/`in` arm in exactly one place (here), not a new code path threaded
// through Cart.tsx or the merchant catalog UI.
import { lineKey, type CartLine } from "../store/cart";
import type { ActionHash, PromoCode, PromoRequirement, PromoReward } from "../holochain/types";
import { bytesToHex } from "../holochain/decode";
import { formatCents } from "./format";
import { t } from "../i18n";

/// The cart's lines of `itemRef` -- the same item may be on several, with
/// different choices.
function linesOf(lines: CartLine[], itemRef: ActionHash): CartLine[] {
  const key = bytesToHex(itemRef);
  return lines.filter((l) => bytesToHex(l.itemRef) === key);
}

/// Up to `quantity` units of `itemRef`, taken from its lines in order, each
/// discounted `perUnit` of its line's base price -- an item promo takes off
/// the item, its paid choices still charged (`catalog_types::pricing`).
function itemDiscount(lines: CartLine[], itemRef: ActionHash, quantity: number, perUnit: (basePrice: number) => number): PromoEffect {
  let left = quantity;
  const itemEffects: PromoItemEffect[] = [];
  for (const line of linesOf(lines, itemRef)) {
    const units = Math.min(left, line.quantity);
    if (units > 0) itemEffects.push({ lineKey: lineKey(line), quantity: units, discountCentsPerUnit: perUnit(line.basePriceCents) });
    left -= units;
  }
  return { subtotalDiscountCents: itemEffects.reduce((sum, e) => sum + e.quantity * e.discountCentsPerUnit, 0), itemEffects };
}

/// `completedOrderCount` is only meaningful for `LoyaltyOrderCount` --
/// optional and defaulted to 0 so every other requirement variant's
/// existing callers (which have no reason to know this) don't need to
/// change. Counting "how many times has this customer ordered here" is
/// the same client-side/best-effort trust tier as every other promo's
/// arithmetic -- see `PromoRequirement::LoyaltyOrderCount`'s own Rust doc
/// comment.
export function isPromoEligible(requirement: PromoRequirement, lines: CartLine[], subtotalCents: number, completedOrderCount = 0): boolean {
  if (requirement === "None") return true;
  if ("MinimumSpend" in requirement) return subtotalCents >= requirement.MinimumSpend;
  if ("MinimumItemQuantity" in requirement) {
    const { item_ref, quantity } = requirement.MinimumItemQuantity;
    return linesOf(lines, item_ref).reduce((n, l) => n + l.quantity, 0) >= quantity;
  }
  if ("LoyaltyOrderCount" in requirement) return completedOrderCount >= requirement.LoyaltyOrderCount;
  return false;
}

/// One line-item effect: `quantity` units of the cart line keyed `lineKey`
/// each get `discountCentsPerUnit` knocked off (the whole item when that
/// equals its base price).
export interface PromoItemEffect {
  lineKey: string;
  quantity: number;
  discountCentsPerUnit: number;
}

export interface PromoEffect {
  /// A flat discount applied to the whole subtotal -- 0 for item-scoped rewards.
  subtotalDiscountCents: number;
  /// Item-scoped discounts -- empty for whole-subtotal rewards.
  itemEffects: PromoItemEffect[];
}

const NO_EFFECT: PromoEffect = { subtotalDiscountCents: 0, itemEffects: [] };

export function computePromoEffect(reward: PromoReward, lines: CartLine[], subtotalCents: number): PromoEffect {
  if ("PercentOffSubtotal" in reward) {
    return { subtotalDiscountCents: Math.floor((subtotalCents * reward.PercentOffSubtotal) / 100), itemEffects: [] };
  }
  if ("FlatOffSubtotal" in reward) {
    return { subtotalDiscountCents: Math.min(reward.FlatOffSubtotal, subtotalCents), itemEffects: [] };
  }
  if ("FreeItem" in reward) {
    const { item_ref, quantity } = reward.FreeItem;
    return itemDiscount(lines, item_ref, quantity, (base) => base);
  }
  if ("PercentOffItem" in reward) {
    const { item_ref, percent, quantity } = reward.PercentOffItem;
    return itemDiscount(lines, item_ref, quantity, (base) => Math.floor((base * percent) / 100));
  }
  return NO_EFFECT;
}

export interface PromoEvaluation {
  eligible: boolean;
  effect: PromoEffect;
}

/// The one entry point callers actually need: is this cart eligible, and if
/// so, what does it save. Ineligible carts get a zeroed effect rather than
/// whatever `computePromoEffect` would compute against a cart that hasn't
/// actually earned the reward.
export function evaluatePromo(promo: PromoCode, lines: CartLine[], subtotalCents: number, completedOrderCount = 0): PromoEvaluation {
  const eligible = isPromoEligible(promo.requirement, lines, subtotalCents, completedOrderCount);
  return { eligible, effect: eligible ? computePromoEffect(promo.reward, lines, subtotalCents) : NO_EFFECT };
}

/// Human-readable summaries for both merchant management UI and customer
/// redemption UI, so neither has to hand-write per-variant copy. `itemName`
/// resolves an item_ref (hex) to a display name -- callers already have a
/// menu loaded for their own purposes (merchant catalog editing, customer
/// browsing), so this takes a lookup rather than fetching anything itself.
export function describeRequirement(requirement: PromoRequirement, itemName: (hex: string) => string | undefined): string {
  if (requirement === "None") return t("promo.req.none");
  if ("MinimumSpend" in requirement) return t("promo.req.spend", { amount: formatCents(requirement.MinimumSpend) });
  if ("MinimumItemQuantity" in requirement) {
    const { item_ref, quantity } = requirement.MinimumItemQuantity;
    return t("promo.req.buy", { quantity, item: itemName(bytesToHex(item_ref)) ?? t("promo.qualifyingItem") });
  }
  if ("LoyaltyOrderCount" in requirement) return t("promo.req.loyalty", { count: requirement.LoyaltyOrderCount });
  return t("promo.req.unknown");
}

export function describeReward(reward: PromoReward, itemName: (hex: string) => string | undefined): string {
  if ("PercentOffSubtotal" in reward) return t("promo.reward.percentOrder", { percent: reward.PercentOffSubtotal });
  if ("FlatOffSubtotal" in reward) return t("promo.reward.flatOrder", { amount: formatCents(reward.FlatOffSubtotal) });
  if ("FreeItem" in reward) {
    const { item_ref, quantity } = reward.FreeItem;
    return t("promo.reward.free", { count: quantity, item: itemName(bytesToHex(item_ref)) ?? t("promo.item") });
  }
  if ("PercentOffItem" in reward) {
    const { item_ref, percent, quantity } = reward.PercentOffItem;
    return t("promo.reward.percentItem", { percent, count: quantity, item: itemName(bytesToHex(item_ref)) ?? t("promo.item") });
  }
  return t("promo.reward.unknown");
}
