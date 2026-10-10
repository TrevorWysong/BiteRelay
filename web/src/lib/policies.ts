// The policies page's content: how money, deliveries, problems and
// disputes work on Relay, and what each can mean for you over time.
//
// Keep it true. Every statement here describes a rule the network's
// validation or the app enforces (see SECURITY.md); numbers that a network
// can set are filled in from its own settings (`NetworkTerms`), never typed
// here. When a rule changes, change the text, bump `POLICY_VERSION`, and
// add a line to `POLICY_CHANGES`.
import { HANDOFF_CODE_DIGITS, type NetworkTerms } from "../holochain/types";
import { formatCents } from "./format";

export const POLICY_VERSION = "1.1";
export const POLICY_UPDATED = "2026-10-09";

export const POLICY_CHANGES: { version: string; date: string; summary: string }[] = [
  {
    version: "1.1",
    date: "2026-10-09",
    summary:
      "No arbitrators. Handoffs are proved by the giver's code or their own confirmation, at pickup as at the door. Leaving an order at the door is the customer's choice and risk. The store decides a delivery that never arrived (paid either way, by the customer or by the driver's collateral) and has the final say on missing items. Drivers carry a limited number of orders at once, and a priority order goes alone.",
  },
  {
    version: "1.0",
    date: "2026-10-09",
    summary: "First published: payments held in escrow, delivery PINs and handover scans, the issue window for missing items, disputes, reputation, privacy and risks.",
  },
];

export type Audience = "customers" | "stores" | "drivers";

/// What a rule means for one kind of participant, over time: the upside
/// (`good`) and what it costs them when it goes against them (`bad`).
export interface Effect {
  who: Audience;
  good?: string;
  bad?: string;
}

export interface PolicySection {
  id: string;
  title: string;
  summary: string;
  points: string[];
  effects?: Effect[];
}

/// A duration as people say it: "2 hours", "30 minutes", "1 day".
export function spoken(secs: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (secs % 86_400 === 0) return unit(secs / 86_400, "day");
  if (secs % 3_600 === 0) return unit(secs / 3_600, "hour");
  if (secs % 60 === 0) return unit(secs / 60, "minute");
  return unit(secs, "second");
}

export function policySections(t: NetworkTerms): PolicySection[] {
  const reportWindow = spoken(t.report_window_secs);
  return [
    {
      id: "payments",
      title: "Payments and escrow",
      summary: "Money is set aside at each step and moves only on proof or on the store's decision about the order. Relay takes no fee.",
      points: [
        "When a store accepts your order, the price of the food is set aside from your balance. When you accept a driver's bid, their fee and your tip are set aside too.",
        "The driver sets aside the value of the food when they pick it up. That's their collateral: it's theirs again once the order is delivered.",
        "Each part of a payment is decided once. Nobody can collect it twice or take back what's been paid.",
        "Your balance is the arithmetic of your own signed ledger. Every entry is on the Transparency page.",
        t.credit_limit_cents > 0
          ? `This network lets a balance go up to ${formatCents(t.credit_limit_cents)} below zero.`
          : "A balance can't go below zero on this network: you can only spend what you've deposited.",
        "There is no platform fee and no operator account. Stores, drivers and customers pay each other directly.",
      ],
    },
    {
      id: "handoffs",
      title: "Handing over an order",
      summary: "Every handoff is proved by whoever hands the order over: the store at pickup, the customer at the door.",
      points: [
        `The store and the customer each have a ${HANDOFF_CODE_DIGITS}-digit code for the order, shown on their screen with a QR code. Only they can see it.`,
        `The driver scans the code, or types the digits read out to them, or the giver taps to confirm in their own app. Any one of them proves the handoff. After ${t.max_code_attempts} wrong codes, typing stops working for that order.`,
        "A driver can't pick up an order without the store's proof, and can't complete a delivery without the customer's.",
        "Share your code only once the order is in your hands: it proves you received it, and can't be taken back.",
        "If you choose to have your order left at the door, you accept that it's delivered once your driver leaves it there. They photograph where; if it's taken after that, it isn't refunded.",
        "Stores can set a limit above which they always hand orders over in person.",
      ],
      effects: [
        { who: "customers", good: "Nobody can mark your order delivered without your code or your say-so, unless you chose to have it left at the door.", bad: "Giving your code before checking your order means accepting it as delivered." },
        { who: "drivers", good: "A delivery completed with the customer's code or confirmation is final: nobody can say later it never arrived.", bad: "Without the customer's proof you can't complete a hand-to-me delivery, and you're paid only once it's complete." },
        { who: "stores", good: "Once the driver has your code, the food is in their care, covered by their collateral.", bad: "Hand over the code only with the food: it's your word that the driver has it." },
      ],
    },
    {
      id: "items",
      title: "Missing or wrong items",
      summary: `You have ${reportWindow} after you get your order to report a problem with your items. The store reviews each report and has the final say.`,
      points: [
        "Choose the items and quantities that were missing or wrong, and add a note or photo if you like. The refund for each item is its share of what you actually paid, after any promo.",
        "The store accepts or declines each report, and its answer is final, as it would be if you'd ordered from it directly.",
        `The store's payment for the food waits until your window closes. Reports it accepts, or never answers, are refunded then; however late you report, the store gets at least ${spoken(t.answer_grace_secs)} to answer.`,
        "Your driver's pay doesn't wait for this window: what's inside a sealed bag isn't theirs to answer for.",
        "Your note and photo are sealed to the store. Nobody else can read them.",
      ],
      effects: [
        { who: "customers", good: "A store that ignores your report refunds it.", bad: "A store can decline a report. Your review is how others find out if it does so unfairly." },
        { who: "stores", good: "You decide every refund. Nobody can grant one over your answer.", bad: "You're paid for the food once the report window closes, not at the door, and reports you don't answer are refunded." },
      ],
    },
    {
      id: "never-arrived",
      title: "If an order never arrives",
      summary: "The driver is accountable for the food from the moment they pick it up until the customer has it.",
      points: [
        "Once your driver has picked up your order, and until it's delivered, you can say it never arrived. Your driver can still turn up and hand it over as usual.",
        `If they don't, the store decides. Its app does so on its own once your claim has stood for ${spoken(t.claim_grace_secs)}, or the store can decide sooner.`,
        "When the store decides it never arrived, you get back what you paid for the food, the delivery fee and your tip. The store gets back its share of the fee, and the driver's collateral pays the store for the food.",
        "The store is paid for the food either way, by you if it arrived or by the driver if it didn't, so it has nothing to gain from either answer.",
        "A delivery completed with your code, your confirmation, or left at your door as you chose, can't be claimed afterwards.",
      ],
      effects: [
        { who: "customers", good: "You're never out of pocket for food that didn't reach you.", bad: "If you say it never arrived and it's then delivered, that goes on your record, where drivers see it." },
        { who: "drivers", good: "If you hand it over with the customer's code, nobody can claim it didn't arrive.", bad: "If you pick it up and don't deliver it, you lose your collateral and your fee, and it's on your record." },
        { who: "stores", good: "The food is always paid for.", bad: "You decide what happens when a customer and driver disagree, and that decision is public." },
      ],
    },
    {
      id: "drivers",
      title: "How many orders a driver carries",
      summary: `A driver carries at most ${t.max_concurrent_deliveries} order${t.max_concurrent_deliveries === 1 ? "" : "s"} at once, as on the big delivery apps, and you can ask for one with no others.`,
      points: [
        `A driver can take on at most ${t.max_concurrent_deliveries} order${t.max_concurrent_deliveries === 1 ? "" : "s"} at once. The network counts what they've picked up and refuses a pickup past that, so no app can get around it.`,
        `While delivering, a driver is offered only add-ons on their way: orders from a store they're still to collect from, or going within ${t.add_on_detour_km} km of one of their drop-offs.`,
        "Every bid shows how many other orders that driver has, and you choose. A driver can't hide orders they've taken on.",
        "Choose Priority at checkout for a driver with no other orders. Nobody can pick up your order while carrying another, or another while carrying yours. Drivers usually bid more for it.",
        "A driver whose order never arrives is free to take more once their collateral for it is forfeited, which their app does on the store's decision.",
      ],
      effects: [
        { who: "customers", good: "Your order isn't one of many on a long route, and Priority guarantees it's the only one.", bad: "A Priority order may wait longer for a driver, and usually costs more." },
        { who: "drivers", good: "Add-ons on your way earn more for the same trip.", bad: "Past the limit, or on a Priority order, you're offered nothing more until you deliver." },
      ],
    },
    {
      id: "cancellations",
      title: "Cancellations",
      summary: "What a cancellation costs depends on how far the order had got.",
      points: [
        "Before a store accepts your order, cancelling costs nothing.",
        "After the store accepts, cancelling means the store keeps the price of the food it started on. After a driver is assigned, the driver keeps their fee as well. Your tip always comes back to you.",
        "If a store or driver cancels, everything they'd have been paid is returned to you.",
        "Once the driver has picked up your order, it can't be cancelled: it's either delivered, or it never arrives (see above).",
      ],
    },
    {
      id: "who-decides",
      title: "Who decides",
      summary: "There's no company, operator or referee. Proof settles almost everything; where it can't, the store decides, within rules everyone's app enforces.",
      points: [
        "A handoff code, a confirmation, or a cancellation settles an order on its own.",
        "For each order, the store writes one outcome and one settlement of the food, and the network accepts no second of either. Every payment rests on them, so no two payments can contradict each other.",
        "The store can't take both the customer's money and the driver's collateral, can't refund more than the reports it cites are worth, and can't decide an order it cancelled went undelivered.",
        "Every decision is signed and public, and recorded against whoever it went against.",
      ],
    },
    {
      id: "reputation",
      title: "Reputation over time",
      summary: "Your history follows you, and it's built only from things that actually happened.",
      points: [
        "Ratings are one vote per customer per order, and only from that order's customer.",
        "Completed orders are recorded for the store and driver. A store's decision that an order never arrived is recorded against the driver; that a claimed order had arrived, against the customer.",
        "Nobody can edit or delete reviews, ratings or history, including their own.",
        "Drivers see a customer's history before they bid.",
      ],
      effects: [
        { who: "customers", good: "A clean history means drivers are glad to take your orders.", bad: "Saying an order never arrived when it had stays on your record." },
        { who: "stores", good: "Completed orders and good ratings build the rating customers see.", bad: "Ratings can't be removed, even unfair ones." },
        { who: "drivers", good: "Completed deliveries build the record customers see when choosing a bid.", bad: "Orders that never arrived stay on your record." },
      ],
    },
    {
      id: "privacy",
      title: "Privacy",
      summary: "You're known by a key, not a name. What's private is sealed; what isn't is said here.",
      points: [
        "Customers publish no name. Your name and exact address are sealed to the store and to the driver you accept, for that order only.",
        "Handoff photos and locations are sealed between the two people at the handoff.",
        "Drivers publish no location. They find work by reading the open orders around them.",
        "Visible to anyone: which customer key ordered from which store, an order's prices, and its drop-off area to within about a kilometre.",
      ],
    },
  ];
}

/// What could go wrong, plainly.
export function policyRisks(): string[] {
  return [
    "Relay is software run by its users, not a company that stands behind your orders. No one can reverse a payment the network has settled, and there's no customer service desk.",
    "When a customer and driver disagree about a delivery, the store decides. A store could side with a customer against a driver who did deliver; it gains nothing by it, and its decision is public, but the network can't overturn it. Drivers are protected by handing over against the customer's code.",
    "An order left at the door is delivered once it's left. If it's taken after that, the customer bears the loss, as with a parcel left without a signature.",
    "Nothing forces a store to answer a report about missing items before it settles the order; a store that settles early, or declines unfairly, answers to its reviews.",
    "Balances are credits issued by this network's issuers. What a balance is worth outside Relay depends on those issuers, not on Relay.",
    "Everything you publish is permanent and copied across the network. Reviews, ratings and order records can't be deleted.",
    "Which store a customer key ordered from, and roughly where, is public. Using one identity for everything links those orders together.",
    "Reviews can't detect a store buying from itself under another identity to rate itself.",
    "Some deadlines (store response times, report windows, scheduled orders, promo expiry) rely on clocks people control. The rules above bound the damage but can't remove it entirely.",
    "The software is provided as is, without warranty. Check your order before confirming it, and keep your device and identity secure.",
  ];
}
