// The demo world `npm run seed` creates -- plain data, also read by the
// browser smoke tests (e2e/) so they know who and what to expect.
// Offsets are in km from the center (east, north) -- everything sits well
// inside the default 8km delivery radius.
export const WORLD = {
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
      // Every day, in the seed's time zone (see seed.mjs).
      hours: { opens: "08:00", closes: "22:00" },
      menu: [
        { name: "Smash Burger", price: 1250, category: "Burgers", description: "Two patties, American cheese, house sauce." },
        { name: "Veggie Burger", price: 1150, category: "Burgers", dietary_tags: ["Vegetarian"] },
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
      menu: [
        { name: "Flat White", price: 475, category: "Coffee" },
        { name: "Almond Croissant", price: 425, category: "Pastries", dietary_tags: ["Vegetarian"] },
        { name: "Chicken Pesto Panini", price: 1195, category: "Lunch" },
        { name: "Lentil Soup", price: 795, category: "Lunch", dietary_tags: ["Vegan", "Gluten-free"] },
      ],
      promos: [{ code: "REGULAR", requirement: { LoyaltyOrderCount: 3 }, reward: { PercentOffSubtotal: 15 }, auto_apply: true }],
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

