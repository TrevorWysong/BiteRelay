// The demo world `npm run seed` creates -- plain data, also read by the
// browser smoke tests (e2e/) so they know who and what to expect.
// Offsets are in km from the center (east, north) -- everything sits well
// inside the default 8km delivery radius.
/// km east, km north of the center.
export type Offset = [east: number, north: number];

export interface WorldPerson {
  /// How the rest of the world names them.
  slug: string;
  name: string;
  roles: ("Requester" | "Merchant" | "Provider")[];
  bio?: string;
  addresses?: { label: string; at: Offset }[];
}

/// A store's choice group; `opens` names a group an option leads on to.
export interface WorldChoiceGroup {
  key: string;
  name: string;
  min: number;
  max: number;
  perOption?: number;
  free?: number;
  options: { name: string; price: number; opens?: string }[];
}

export interface WorldMenuItem {
  name: string;
  price: number;
  category?: string;
  description?: string;
  dietary_tags?: string[];
  /// Its choice groups, by key.
  groups?: string[];
}

export interface WorldStore {
  key: string;
  /// The owner's slug.
  owner: string;
  name: string;
  at: Offset;
  /// Catalog details, as `update_catalog_details` takes them.
  details: { address_street?: string; [field: string]: unknown };
  /// Every day, `HH:MM`; none means open whenever it's taking orders.
  hours?: { opens: string; closes: string };
  groups?: WorldChoiceGroup[];
  menu: WorldMenuItem[];
  promos: { code: string; requirement: unknown; reward: unknown; auto_apply?: boolean }[];
  /// Its rewards program (`rewards_types::RewardsProgram`), items named
  /// by their menu names -- set up before any of its orders, so they earn.
  rewards?: {
    name: string;
    points_name: string;
    tagline: string;
    accent: string;
    points_per_dollar: number;
    welcome_bonus: number;
    item_bonuses: { item: string; percent: number }[];
    happy_hours: { days: number; start_minute: number; end_minute: number; percent: number }[];
    tiers: { name: string; threshold: number; percent: number; perk: string }[];
    rewards: { name: string; cost: number; free?: string; flat_off?: number; min_tier?: number }[];
    birthday_points: number;
    expiry_days: number | null;
  };
  goodieBag?: { title: string; original: number; price: number; quantity: number };
}

export type DeliveryStep = "Placed" | "Open" | "BidPlaced" | "BidAccepted" | "MerchantConfirmed" | "PickedUp" | "Delivered";
export type PickupStep = "Placed" | "MerchantConfirmed" | "ReadyForPickup" | "PickedUp";

interface OrderCommon {
  /// Slugs and keys of who and where.
  customer: string;
  store: string;
  /// Menu item names, one each.
  items: string[];
  instructions?: string;
  /// What it's there to show, for whoever reads this.
  note?: string;
  review?: { store: number; driver?: number; comment: string };
}

export type WorldOrder = (OrderCommon & { kind: "delivery"; until: DeliveryStep; driver?: string }) | (OrderCommon & { kind: "pickup"; until: PickupStep });

export const WORLD: { people: WorldPerson[]; stores: WorldStore[]; orders: WorldOrder[] } = {
  people: [
    { slug: "mo", name: "Mo Haddad", roles: ["Requester", "Merchant", "Provider"], bio: "Runs Mo's Kitchen and Mo's Tacos, and drives on slow nights." },
    { slug: "cara", name: "Cara Okafor", roles: ["Merchant"], bio: "Owner of Cara's Café." },
    { slug: "dana", name: "Dana Reyes", roles: ["Provider"], bio: "Full-time courier." },
    { slug: "sam", name: "Sam Patel", roles: ["Requester"], addresses: [{ label: "Home", at: [0.6, -0.9] }, { label: "Work", at: [-1.8, 1.1] }] },
    { slug: "lee", name: "Lee Chen", roles: ["Requester"], addresses: [{ label: "Home", at: [1.4, 0.7] }] },
    // A customer with nothing on order yet: the others each have as many
    // waiting on stores as the network allows at once.
    { slug: "ana", name: "Ana Silva", roles: ["Requester"], addresses: [{ label: "Home", at: [0.9, 0.2] }] },
  ],
  stores: [
    {
      key: "kitchen",
      owner: "mo",
      name: "Mo's Kitchen",
      at: [0.4, 0.3],
      details: { cuisine_type: "American", description: "Burgers, bowls and breakfast all day.", address_street: "120 Central Ave", prep_minutes: 15 },
      // Every day, in the seed's time zone (see seed.ts).
      hours: { opens: "08:00", closes: "22:00" },
      // Choice groups, created in order -- a group an option opens comes
      // before it. Items list theirs by key.
      groups: [
        { key: "friesSize", name: "Fries size", min: 1, max: 1, options: [{ name: "Regular", price: 0 }, { name: "Large", price: 100 }] },
        { key: "combo", name: "Make it a combo", min: 0, max: 1, options: [{ name: "Fries", price: 350, opens: "friesSize" }, { name: "Side salad", price: 400 }] },
        { key: "addOns", name: "Add-ons", min: 0, max: 3, free: 1, options: [{ name: "Cheese", price: 100 }, { name: "Avocado", price: 150 }, { name: "Jalapeños", price: 50 }] },
      ],
      menu: [
        { name: "Smash Burger", price: 1250, category: "Burgers", description: "Two patties, American cheese, house sauce." },
        { name: "Veggie Burger", price: 1150, category: "Burgers", dietary_tags: ["Vegetarian"], groups: ["addOns", "combo"], description: "One add-on free." },
        { name: "Harvest Bowl", price: 1350, category: "Bowls", dietary_tags: ["Vegan", "Gluten-free"] },
        { name: "Hand-cut Fries", price: 450, category: "Sides", dietary_tags: ["Vegan"] },
        { name: "Pancake Stack", price: 950, category: "Breakfast", dietary_tags: ["Vegetarian"] },
      ],
      promos: [{ code: "WELCOME10", requirement: "None", reward: { PercentOffSubtotal: 10 } }],
    },
    {
      key: "tacos",
      owner: "mo",
      name: "Mo's Tacos",
      at: [-0.7, 0.5],
      // No set hours -- open whenever it's taking orders, so the browser
      // smoke tests can order from it at any time of day.
      details: { cuisine_type: "Mexican", description: "Street tacos from the same family kitchen.", address_street: "455 1st Ave N", prep_minutes: 10 },
      menu: [
        { name: "Al Pastor Taco", price: 450, category: "Tacos" },
        { name: "Mushroom Taco", price: 425, category: "Tacos", dietary_tags: ["Vegetarian"] },
        { name: "Elote", price: 500, category: "Sides", dietary_tags: ["Vegetarian", "Gluten-free"] },
        { name: "Horchata", price: 375, category: "Drinks" },
      ],
      promos: [],
    },
    {
      key: "cafe",
      owner: "cara",
      name: "Cara's Café",
      at: [1.1, -0.4],
      details: { cuisine_type: "Café", description: "Coffee, pastries and lunch plates.", address_street: "88 Beach Dr NE", prep_minutes: 8 },
      hours: { opens: "07:00", closes: "18:00" },
      groups: [
        { key: "size", name: "Size", min: 1, max: 1, options: [{ name: "Small", price: 0 }, { name: "Large", price: 75 }] },
        { key: "milk", name: "Milk", min: 0, max: 1, options: [{ name: "Whole", price: 0 }, { name: "Oat", price: 60 }, { name: "Almond", price: 60 }] },
        { key: "extras", name: "Extras", min: 0, max: 4, perOption: 3, options: [{ name: "Extra shot", price: 80 }, { name: "Vanilla syrup", price: 50 }] },
      ],
      menu: [
        { name: "Latte", price: 450, category: "Coffee", groups: ["size", "milk", "extras"] },
        { name: "Flat White", price: 475, category: "Coffee" },
        { name: "Almond Croissant", price: 425, category: "Pastries", dietary_tags: ["Vegetarian"] },
        { name: "Chicken Pesto Panini", price: 1195, category: "Lunch" },
        { name: "Lentil Soup", price: 795, category: "Lunch", dietary_tags: ["Vegan", "Gluten-free"] },
      ],
      promos: [{ code: "REGULAR", requirement: { LoyaltyOrderCount: 3 }, reward: { PercentOffSubtotal: 15 }, auto_apply: true }],
      rewards: {
        name: "Café Club",
        points_name: "beans",
        tagline: "Every cup gets you closer to a free one",
        accent: "Citrus",
        points_per_dollar: 10,
        welcome_bonus: 100,
        item_bonuses: [{ item: "Lentil Soup", percent: 200 }],
        happy_hours: [{ days: 0b0011111, start_minute: 14 * 60, end_minute: 16 * 60, percent: 200 }],
        tiers: [
          { name: "Gold", threshold: 1500, percent: 125, perk: "Free extra shot, always" },
          { name: "Platinum", threshold: 4000, percent: 150, perk: "First taste of every new pastry" },
        ],
        rewards: [
          { name: "Free Almond Croissant", cost: 300, free: "Almond Croissant" },
          { name: "Free Latte", cost: 450, free: "Latte" },
          { name: "$5 off", cost: 600, flat_off: 500 },
          { name: "Free Panini", cost: 1100, free: "Chicken Pesto Panini", min_tier: 1 },
        ],
        birthday_points: 250,
        expiry_days: 365,
      },
      goodieBag: { title: "End-of-day pastry bag", original: 1800, price: 600, quantity: 4 },
    },
  ],
  // `until` is the state the order is driven to; reviews are left on
  // completed ones. Items are menu item names from the order's store;
  // `note` only documents why the order is in the world.
  orders: [
    { kind: "delivery", customer: "lee", store: "tacos", items: ["Mushroom Taco", "Elote"], until: "Placed", note: "Store needs to accept it" },
    { kind: "delivery", customer: "sam", store: "kitchen", items: ["Smash Burger", "Hand-cut Fries"], until: "Open", instructions: "No pickles please", note: "Waiting for a driver to bid" },
    { kind: "delivery", customer: "lee", store: "cafe", items: ["Flat White", "Almond Croissant"], until: "BidPlaced", driver: "dana", note: "Has a bid for the customer to accept" },
    { kind: "delivery", customer: "sam", store: "tacos", items: ["Al Pastor Taco", "Al Pastor Taco", "Elote"], until: "BidAccepted", driver: "dana", note: "Merchant needs to confirm prep" },
    { kind: "delivery", customer: "lee", store: "kitchen", items: ["Harvest Bowl"], until: "PickedUp", driver: "dana", note: "Driver en route to the customer" },
    { kind: "delivery", customer: "sam", store: "cafe", items: ["Chicken Pesto Panini", "Lentil Soup"], until: "Delivered", driver: "dana", review: { store: 5, driver: 5, comment: "Still hot when it arrived." } },
    { kind: "delivery", customer: "lee", store: "tacos", items: ["Mushroom Taco", "Horchata"], until: "Delivered", driver: "dana", review: { store: 4, driver: 5, comment: "Great tacos, quick handoff." } },
    { kind: "pickup", customer: "sam", store: "kitchen", items: ["Pancake Stack"], until: "Placed", note: "Store needs to accept it" },
    { kind: "pickup", customer: "lee", store: "cafe", items: ["Flat White"], until: "ReadyForPickup", note: "Customer needs to collect it" },
    { kind: "pickup", customer: "sam", store: "tacos", items: ["Al Pastor Taco"], until: "PickedUp", review: { store: 5, comment: "Ready right on time." } },
  ],
};

