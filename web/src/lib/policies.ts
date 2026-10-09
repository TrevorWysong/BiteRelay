// The policies page's content: how money, deliveries, problems and
// disputes work on Relay, and what each can mean for you over time.
//
// Keep it true. Every statement here describes a rule the network's
// validation or the app enforces (see SECURITY.md); numbers that a network
// can set are filled in from its own settings (`NetworkTerms`), never typed
// here. When a rule changes, change the text, bump `POLICY_VERSION`, and
// add a line to `POLICY_CHANGES`.
import type { NetworkTerms } from "../holochain/types";

export const POLICY_VERSION = "1.0";
export const POLICY_UPDATED = "2026-10-09";

export const POLICY_CHANGES: { version: string; date: string; summary: string }[] = [
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
  const arbitrated = t.arbitrators.length > 0;
  const grace = spoken(Math.min(30 * 60, t.issue_window_secs));
  return [
    {
      id: "payments",
      title: "Payments and escrow",
      summary: "Money is set aside at each step and released by proof, not by anyone's say-so. Relay takes no fee.",
      points: [
        "When a store accepts your order, the price of the food is set aside from your balance. When you accept a driver's bid, their fee and your tip are set aside too.",
        "Set-aside money moves only on evidence the network checks: your confirmation, a handover scan, the close of an issue window, a cancellation that entitles someone, or an arbitrator's ruling.",
        "Each part of a payment is decided once. Nobody can collect it twice or take back what's been paid.",
        "Your balance is the arithmetic of your own signed ledger. Every entry is shown on the Transparency page.",
        t.credit_limit_cents > 0
          ? `This network lets a balance go up to ${(t.credit_limit_cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" })} below zero.`
          : "A balance can't go below zero on this network: you can only spend what you've deposited.",
        "There is no platform fee and no operator account. Stores, drivers and customers pay each other directly.",
      ],
    },
    {
      id: "delivery",
      title: "Confirming a delivery",
      summary: "Every delivery has a 6-digit PIN only you can see. Giving it, or letting your driver scan it, is your signature.",
      points: [
        "Share your PIN or show your handover code only once the order is in your hands. Either one proves you received it, and can't be taken back.",
        "Stores choose when drivers must collect the PIN: never, only from customers who have lost a dispute (the default), or always. Drivers see this before they bid.",
        "A driver who scans your handover code completes the delivery on the spot and is paid at once. A delivery completed this way can't be disputed later.",
        `When a driver records a drop-off without a scan, you're notified right away and have ${spoken(t.confirm_window_secs)} to confirm it or report a problem (${spoken(t.pin_confirm_window_secs)} if you gave your PIN).`,
        "If you don't respond in time, the delivery goes to an arbitrator with the driver's evidence. Staying silent doesn't refund you.",
      ],
      effects: [
        { who: "customers", good: "Your PIN can't be guessed: only a hash of it is public, and nobody can test guesses against it.", bad: "Giving your PIN or code before checking your order means accepting it as delivered." },
        { who: "drivers", good: "A PIN or scan is the strongest proof of delivery there is. It's ruled in your favor automatically.", bad: "Without a PIN, your photo is your word; an undisputed, photographed drop-off is ruled for you, a disputed one goes to a person." },
      ],
    },
    {
      id: "items",
      title: "Missing or wrong items",
      summary: arbitrated
        ? `You have ${spoken(t.issue_window_secs)} after delivery to report a problem with your items. The store reviews each report and has the final say.`
        : "On this network, stores are paid when you confirm your order, and missing items are settled with the store directly.",
      points: arbitrated
        ? [
            `Once your order is confirmed, the store's payment for the food is held for ${spoken(t.issue_window_secs)}. Your driver is paid right away: what's inside a sealed bag isn't theirs to answer for.`,
            "Choose the items and quantities that were missing or wrong, and add a note or photo if you like. The refund for each item is its share of what you actually paid, after any promo.",
            "The store accepts or declines each report, and its answer is final, just as if you'd ordered from it directly.",
            `A report the store doesn't answer is refunded. However late you report, the store gets at least ${grace} to answer.`,
            "When the window closes, refunds return to your balance and the store receives the rest.",
            "Your note and photo are sealed to the store and the network's arbitrators. Nobody else can read them.",
          ]
        : ["This network has no arbitrators, so there is no window for reporting problems after delivery."],
      effects: arbitrated
        ? [
            { who: "customers", good: "A store that ignores you can't keep your money for items you didn't get.", bad: "A store can decline a report. If you think it does so unfairly, your review is how others find out." },
            { who: "stores", good: "You decide every refund. Nobody can grant one over your answer.", bad: "You're paid for food after the window closes, not at the door, and unanswered reports are refunded." },
          ]
        : undefined,
    },
    {
      id: "cancellations",
      title: "Cancellations",
      summary: "What a cancellation costs depends on how far the order had got.",
      points: [
        "Before a store accepts your order, cancelling costs nothing.",
        "After the store accepts, cancelling means the store keeps the price of the food it started on. After a driver is assigned, the driver keeps their fee as well. Your tip always comes back to you.",
        "If a store or driver cancels, everything they'd have been paid is returned to you.",
        arbitrated ? "If a cancellation by a store or driver seems unfair, you can ask an arbitrator to review it." : "Cancellations can't be appealed on this network.",
      ],
    },
    {
      id: "disputes",
      title: "Disputes and arbitrators",
      summary: arbitrated
        ? "Arbitrators settle what proof alone can't, mainly orders that may never have arrived."
        : "This network has no arbitrators, so disputes can't be settled on it.",
      points: arbitrated
        ? [
            `The arbitrators are the ${t.arbitrators.length === 1 ? "person" : `${t.arbitrators.length} people`} chosen by whoever runs this network, listed by their keys below. Only they can rule, and every ruling is public and signed.`,
            "Clear cases are ruled automatically within minutes: a correct PIN collected at the door, or an unconfirmed drop-off the driver photographed and the customer never disputed.",
            "Everything else waits for a person, who sees the driver's sealed evidence (shared with arbitrators only for the dispute) and each side's history.",
            "If an order is ruled delivered, the store and driver are paid. If it's ruled never delivered, you're refunded and the driver's collateral (the value of the food, set aside at pickup) goes to the store.",
            "Arbitrators can't move money themselves, refund more than an order cost, or overturn a delivery completed on a scan.",
            "Each order's issue window is kept by one arbitrator, on their own clock. They don't decide item reports; they apply the store's answers.",
          ]
        : ["Orders are settled by proof alone: your confirmation, a handover scan, or a cancellation."],
      effects: arbitrated
        ? [
            { who: "customers", good: "If your food never came, an arbitrator can refund you in full.", bad: "Losing a dispute is on your record: stores using the default setting will ask for your PIN from then on, and drivers see your history before they bid." },
            { who: "drivers", good: "Delivering with a PIN or scan means disputes about that order are settled for you.", bad: "Losing a dispute forfeits your collateral to the store and is recorded against you." },
            { who: "stores", good: "If a driver loses your order, their collateral covers the food.", bad: "A dispute about your order holds your payment until it's ruled." },
          ]
        : undefined,
    },
    {
      id: "reputation",
      title: "Reputation over time",
      summary: "Your history follows you, and it's built only from things that actually happened.",
      points: [
        "Ratings are one vote per customer per order, and only from that order's customer.",
        "Completed orders and dispute outcomes are recorded against the store, driver or customer involved, and only that order's parties or an arbitrator can record them.",
        "Nobody can edit or delete reviews, ratings or history, including their own.",
        "Drivers see a customer's history, and whether the store wants their PIN, before they bid.",
      ],
      effects: [
        { who: "customers", good: "A clean history means fewer checks at the door.", bad: "Each lost dispute makes PIN checks more likely and may make drivers less keen to bid." },
        { who: "stores", good: "Completed orders and good ratings build the rating customers see.", bad: "Ratings can't be removed, even unfair ones." },
        { who: "drivers", good: "Completed deliveries build the record customers see when choosing a bid.", bad: "Lost disputes stay on your record." },
      ],
    },
    {
      id: "privacy",
      title: "Privacy",
      summary: "You're known by a key, not a name. What's private is sealed; what isn't is said here.",
      points: [
        "Customers publish no name. Your name and exact address are sealed to the store and to the driver you accept, for that order only.",
        "Handoff photos and locations are sealed between the two people at the handoff, and reach arbitrators only if one of them shares them for a dispute.",
        "Drivers publish no location. They find work by reading the open orders around them.",
        "Visible to anyone: which customer key ordered from which store, an order's prices, and its drop-off area to within about a kilometre.",
      ],
    },
  ];
}

/// What could go wrong, plainly.
export function policyRisks(t: NetworkTerms): string[] {
  const arbitrated = t.arbitrators.length > 0;
  return [
    "Relay is software run by its users, not a company that stands behind your orders. No one can reverse a payment the network has settled, and no customer service desk exists beyond the network's arbitrators.",
    arbitrated
      ? "Arbitrators are trusted. An arbitrator could rule a dispute unfairly or be slow to act. Their rulings are public, signed and permanent, so misconduct is visible, but it can't be undone by the network."
      : "This network has no arbitrators: a dispute that proof can't settle has no one to settle it.",
    "Without a PIN or scan, a drop-off photo is the driver's word. Stores that don't require a PIN accept that risk, as a sender does for a parcel left without a signature.",
    "Balances are credits issued by this network's issuers. What a balance is worth outside Relay depends on those issuers, not on Relay.",
    "Everything you publish is permanent and copied across the network. Reviews, ratings and order records can't be deleted.",
    "Which store a customer key ordered from, and roughly where, is public. Using one identity for everything links those orders together.",
    "Reviews can't detect a store buying from itself under another identity to rate itself.",
    "Some deadlines (store response times, scheduled orders, promo expiry) rely on clocks people control. The rules above bound the damage but can't remove it entirely.",
    "The software is provided as is, without warranty. Check your order before confirming it, and keep your device and identity secure.",
  ];
}
