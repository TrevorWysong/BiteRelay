import { hexToBytes } from "../../../holochain/decode";
import type { PromoRequirement, PromoReward } from "../../../holochain/types";

// Requirement and reward are picked independently (two dropdowns), the
// same way `PromoRequirement`/`PromoReward` are two independent enums in
// Rust: a plain code, "spend $X get item Y free" and BOGO are each just one
// requirement paired with one reward -- never a hard-coded "promo type".
export type RequirementKind = "none" | "minSpend" | "minItemQty" | "loyalty";
export type RewardKind = "percentOffSubtotal" | "flatOffSubtotal" | "freeItem" | "percentOffItem";

export const EMPTY_PROMO_FORM = {
  code: "",
  requirementKind: "none" as RequirementKind,
  /// Dollars (minSpend), units (minItemQty), or prior orders (loyalty).
  requirementAmount: 20,
  requirementItemHex: "",
  rewardKind: "percentOffSubtotal" as RewardKind,
  /// Percent (percentOff*) or dollars (flatOffSubtotal).
  rewardAmount: 10,
  rewardItemHex: "",
  rewardQuantity: 1,
  autoApply: false,
};

export type PromoForm = typeof EMPTY_PROMO_FORM;

/// `null` while the form is incomplete (an item-scoped kind with no item).
export function buildRequirement(form: PromoForm): PromoRequirement | null {
  switch (form.requirementKind) {
    case "none":
      return "None";
    case "minSpend":
      return { MinimumSpend: Math.max(1, Math.round(form.requirementAmount * 100)) };
    case "minItemQty":
      if (!form.requirementItemHex) return null;
      return { MinimumItemQuantity: { item_ref: hexToBytes(form.requirementItemHex), quantity: Math.max(1, Math.round(form.requirementAmount)) } };
    case "loyalty":
      return { LoyaltyOrderCount: Math.max(1, Math.round(form.requirementAmount)) };
  }
}

/// `null` while the form is incomplete (an item-scoped kind with no item).
export function buildReward(form: PromoForm): PromoReward | null {
  const percent = Math.min(100, Math.max(1, Math.round(form.rewardAmount)));
  const quantity = Math.max(1, Math.round(form.rewardQuantity));
  switch (form.rewardKind) {
    case "percentOffSubtotal":
      return { PercentOffSubtotal: percent };
    case "flatOffSubtotal":
      return { FlatOffSubtotal: Math.max(1, Math.round(form.rewardAmount * 100)) };
    case "freeItem":
      if (!form.rewardItemHex) return null;
      return { FreeItem: { item_ref: hexToBytes(form.rewardItemHex), quantity } };
    case "percentOffItem":
      if (!form.rewardItemHex) return null;
      return { PercentOffItem: { item_ref: hexToBytes(form.rewardItemHex), percent, quantity } };
  }
}
