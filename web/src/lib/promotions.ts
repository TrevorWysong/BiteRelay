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
import type { CartLine } from "../store/cart";
import type { ActionHash, PromoCode, PromoRequirement, PromoReward } from "../holochain/types";
import { bytesToHex } from "../holochain/decode";
import { formatCents } from "./format";

function findLine(lines: CartLine[], itemRef: ActionHash): CartLine | undefined {
  const key = bytesToHex(itemRef);
  return lines.find((l) => bytesToHex(l.itemRef) === key);
}

export function isPromoEligible(requirement: PromoRequirement, lines: CartLine[], subtotalCents: number): boolean {
  if (requirement === "None") return true;
  if ("MinimumSpend" in requirement) return subtotalCents >= requirement.MinimumSpend;
  if ("MinimumItemQuantity" in requirement) {
    const { item_ref, quantity } = requirement.MinimumItemQuantity;
    const line = findLine(lines, item_ref);
    return !!line && line.quantity >= quantity;
  }
  return false;
}

/// One line-item effect: `quantity` units of the cart line keyed by
/// `itemRefHex` each get `discountCentsPerUnit` knocked off (fully free
/// when that equals the line's own per-unit price).
export interface PromoItemEffect {
  itemRefHex: string;
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
    const line = findLine(lines, item_ref);
    if (!line) return NO_EFFECT;
    const freeQty = Math.min(quantity, line.quantity);
    const cents = freeQty * line.priceCents;
    return { subtotalDiscountCents: cents, itemEffects: [{ itemRefHex: bytesToHex(item_ref), quantity: freeQty, discountCentsPerUnit: line.priceCents }] };
  }
  if ("PercentOffItem" in reward) {
    const { item_ref, percent, quantity } = reward.PercentOffItem;
    const line = findLine(lines, item_ref);
    if (!line) return NO_EFFECT;
    const affectedQty = Math.min(quantity, line.quantity);
    const perUnit = Math.floor((line.priceCents * percent) / 100);
    return { subtotalDiscountCents: affectedQty * perUnit, itemEffects: [{ itemRefHex: bytesToHex(item_ref), quantity: affectedQty, discountCentsPerUnit: perUnit }] };
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
export function evaluatePromo(promo: PromoCode, lines: CartLine[], subtotalCents: number): PromoEvaluation {
  const eligible = isPromoEligible(promo.requirement, lines, subtotalCents);
  return { eligible, effect: eligible ? computePromoEffect(promo.reward, lines, subtotalCents) : NO_EFFECT };
}

/// Human-readable summaries for both merchant management UI and customer
/// redemption UI, so neither has to hand-write per-variant copy. `itemName`
/// resolves an item_ref (hex) to a display name -- callers already have a
/// menu loaded for their own purposes (merchant catalog editing, customer
/// browsing), so this takes a lookup rather than fetching anything itself.
export function describeRequirement(requirement: PromoRequirement, itemName: (hex: string) => string | undefined): string {
  if (requirement === "None") return "No purchase requirement";
  if ("MinimumSpend" in requirement) return `Spend ${formatCents(requirement.MinimumSpend)} or more`;
  if ("MinimumItemQuantity" in requirement) {
    const { item_ref, quantity } = requirement.MinimumItemQuantity;
    const name = itemName(bytesToHex(item_ref)) ?? "a qualifying item";
    return `Buy ${quantity}+ ${name}`;
  }
  return "Unknown requirement";
}

export function describeReward(reward: PromoReward, itemName: (hex: string) => string | undefined): string {
  if ("PercentOffSubtotal" in reward) return `${reward.PercentOffSubtotal}% off the order`;
  if ("FlatOffSubtotal" in reward) return `${formatCents(reward.FlatOffSubtotal)} off the order`;
  if ("FreeItem" in reward) {
    const { item_ref, quantity } = reward.FreeItem;
    const name = itemName(bytesToHex(item_ref)) ?? "item";
    return quantity === 1 ? `Get a free ${name}` : `Get ${quantity} free ${name}`;
  }
  if ("PercentOffItem" in reward) {
    const { item_ref, percent, quantity } = reward.PercentOffItem;
    const name = itemName(bytesToHex(item_ref)) ?? "item";
    return `${percent}% off ${quantity > 1 ? `${quantity}x ` : ""}${name}`;
  }
  return "Unknown reward";
}
