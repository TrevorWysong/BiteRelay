// English: the source catalog. Every other locale translates these keys,
// and test/i18n.test.ts holds each to the same keys and placeholders.
//
// A message is a string with `{name}` placeholders, or -- when it counts
// something -- plural forms keyed by `Intl.PluralRules` category (`one`,
// `other`, and `zero`/`two`/`few`/`many` where a language has them), with
// the number as `{count}`.
export const en = {
  "mode.customer": "Order",
  "mode.driver": "Drive",
  "mode.merchant": "Sell",
  "nav.browse": "Browse",
  "nav.cart": "Cart",
  "nav.orders": "Orders",
  "nav.dash": "Dash",
  "nav.earnings": "Earnings",
  "nav.menu": "Menu",
  "shell.connected": "connected",
  "shell.newVersion": "A new version of Relay is out. Move your account",
  "language.title": "Language",
  "language.device": "As this device ({language})",
  "appeal.cta": "Appeal the store's decision",
  "appeal.window": "Disagree with the store? You can appeal to the network's arbiter within {days} days of its decision.",
  "appeal.awarded": "The arbiter awarded {amount}",
  "appeal.dismissed": "The arbiter dismissed the appeal",
  "appeal.appealedFor": "Appealed for {amount}",
  "appeal.customerAppealedFor": "The customer appealed for {amount}",
  "appeal.paidToYou": "It's paid to your balance from the store's next cash-out.",
  "appeal.paidByYou": "It comes out of your next cash-out.",
  "appeal.bothIn": "Both sides are in. The arbiter will decide.",
  "appeal.giveSide": "Give the arbiter your side.",
  "appeal.waitingStore": "Waiting for the store's side, then the arbiter decides.",
  "appeal.giveSideButton": "Give your side",
  "appeal.storeWaiting": { one: "A customer appealed your decision", other: "{count} customers appealed your decisions" },
  "verification.until": "Verified until {date}",
  "verification.getVerified": "Get verified",
  "verification.getVerifiedRequired": "Get verified to start delivering",
  "verification.showCode": "Show my code to a verifier",
  "age.badge": "{age}+ · ID at pickup",
  "age.confirm": "Your order has age-restricted items, so it's collected in person. I'm {age} or older and will show ID at the counter.",
} as const satisfies Record<string, Message>;

export type Message = string | { readonly one?: string; readonly other: string; readonly zero?: string; readonly two?: string; readonly few?: string; readonly many?: string };
export type MessageKey = keyof typeof en;
/// A translation: every key, each a message of its own.
export type Catalog = Record<MessageKey, Message>;
