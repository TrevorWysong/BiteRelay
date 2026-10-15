# Sales tax on orders: a plan

How tax is charged on food, fees and tips, and who collects and pays it, when no company sits between store and customer. Research and a proposed design. This is not tax advice: rules differ by state, county and country, and a sales-tax adviser should confirm the approach for each jurisdiction at launch.

## Status (2026-10-15)

**Built.** Stores are the seller of record and set their own tax (store screen → Tax). Each store has:
- up to 8 rates, by category of item, each at most 50%; the first is the default;
- either tax added at checkout (US sales tax) or prices that already include it (VAT, as in most of the world);
- an optional registration number for receipts.

Each menu item picks its category. Every order carries `tax_cents`, and `order_total` includes the tax when it's added on top. Validation recomputes both from the rates of the store version the order cites (`catalog_types::order_tax`): each category's share of the food after any promo, rounded half up per category. So the food hold, refunds for missing items (which are proportional to the order total) and the store's collection all carry the tax with no new money paths.

Checkout shows a tax line, or "Includes £x VAT". Receipts show the tax as it was charged when the order was placed, with the store's registration. The store's **tax report** (orders, sales, tax collected, tax refunded, tax to remit, CSV download) is computed on its own device from its own history.

Tests:
- `tests/tryorama/src/tax.test.ts`;
- the shared cases in `catalog_types` pricing and `web/test/tax.test.ts`.

**Not built:** rate lookup by address (the store enters its combined rate), and taxing the store's share of a delivery fee.

## What the big apps do

- **Marketplace facilitator laws.** Most US states now require a marketplace that facilitates a sale and collects the payment to collect and remit the sales tax on it, in place of the seller.
  - DoorDash, Grubhub and Uber Eats collect and remit tax on menu items in many states.
  - Uber Eats has reported a duty to collect in 31 states.
  - Others, such as California, Illinois and Utah, generally don't impose that duty on food delivery companies.
  ([Toast on marketplace facilitator laws](https://support.toasttab.com/en/article/Understanding-Marketplace-Facilitator-Laws-How-They-Affect-Your-Restaurant), [CohnReznick](https://www.cohnreznick.com/insights/restaurants-marketplace-facilitator-laws-sales-tax-collection))
- **Opting out.** Some states (Maine, Massachusetts, Nebraska) let the restaurant keep collecting if it shows the marketplace its own sales-tax permit (same sources).
- **Delivery fees vary.** Missouri excludes customary, separately stated delivery charges. Indiana taxes delivery of prepared food. In New York, delivery follows the taxability of what's delivered. Florida depends on whether the restaurant also offers pickup. Texas has taxed some app fees. ([Missouri ruling](https://dor.mo.gov/rulings/show/8244), [CPA Practice Advisor on Texas](https://www.cpapracticeadvisor.com/2022/04/10/texas-says-mobile-delivery-app-fees-are-taxable/49032/))
- **Tips are generally not taxable** when voluntary, separately stated and paid in full to the worker (California, Mississippi, New York). A *mandatory* tip is taxable in New York. ([Mississippi notice](https://www.dor.ms.gov/sites/default/files/News/72-20-09%20Notice%20of%20Food%20Delivery%20Services.pdf))

## Who collects in Relay

A marketplace facilitator is usually defined as someone who facilitates a sale *and* collects payment from the buyer and passes it to the seller. That definition is exactly what Relay doesn't have:
- the customer's money moves to the store on the customer's and store's own ledgers;
- no company handles it in between.

States split on software that never touches the payment:
- **Missouri** ruled that a software platform whose users pick their own payment processor, and which never controls the funds, is not a marketplace facilitator ([Missouri LR 8393](https://dor.mo.gov/rulings/show/8393)).
- **Illinois** reads "facilitates" broadly enough to reach platforms with payment functionality even if they don't control the funds ([Bloomberg Tax](https://news.bloombergtax.com/daily-tax-report/illinois-dor-clarifies-marketplace-facilitator-rules-for-software-providers)).

**Recommended stance: the store is the seller of record.** It charges and remits its own sales tax, as a restaurant does for its own phone and counter orders. Relay's job is to make that correct and effortless:
- compute the tax;
- validate it;
- put it on every receipt;
- produce the store's filing report.

**Risk to raise with an adviser:** the card **issuer** collects money (top-ups), but not per sale. Whether a state could treat it as a facilitator should be checked, especially in Illinois-style states.

## Recommended design

### What's taxed
- **Food:** taxed at the store's rate, by item tax category.
  - Prepared food is usually taxable.
  - Some states exempt grocery-type items, such as packaged or bakery goods.
  - Alcohol often has its own rate.
- **Delivery fee:** **not taxed by default.** It's an independent driver's service, separately stated, and not part of the store's sale. A store in a state that taxes delivery charges can switch on "tax my share of the delivery fee", applied to the share it covers.
- **Tip:** never taxed. It's voluntary, separately stated, and all of it goes to the driver, which the ledger already guarantees.
- **Promotions:** tax is computed on the discounted price. A store-funded discount reduces the taxable amount in most states.

### Data model
- **On the store** (`MerchantCatalog`):
  - `tax_rates`: a small list of `{ category, rate_basis_points, label }` (for example "Prepared food 8.25%"), set by the store for its address, the combined state, county and city rate;
  - `prices_include_tax: bool`, for networks outside the US where shelf prices include VAT;
  - `tax_registration: Option<String>`: the store's permit number, shown on receipts.
- **On each menu item:** `tax_category`, defaulting to "prepared food".
- **On the order:** `tax_cents`, frozen at placement from the store version the order cites (`catalog_version`), like the store's fee share today.

### Validation
- **Recomputation.** For each line, tax = line price × rate for its category, rounded per line to the nearest cent. The order's `tax_cents` must equal the sum. This is deterministic, so every peer agrees, and neither the store nor the customer can change it.
- **Holds.** The food hold becomes food + tax, and the store collects both. The ledger records the tax part separately, so the store's filing report can total it.
- **Refunds.** A refund for missing items refunds its share of the tax at the same rate. `claimed_value` gains the tax.

### Rates
- **Phase 1:** the store enters its combined rate. The app shows the rate it will charge at checkout and on receipts, and warns if none is set in a state that taxes prepared food.
- **Phase 2:** a rate-lookup helper in the store's settings, fed by state-published rate tables or a paid API (Avalara, TaxJar, Stripe Tax). Validation never calls it: the rate still lives on the store's terms and is checked from there.

### Screens
- **Checkout:** a "Tax" line beside the subtotal and fees.
- **Receipts:** tax by category, plus the store's registration number.
- **Store:** a "Tax" settings card, and the store's tax report (see `TAX_REPORTING.md`).

## What to build
1. Catalog fields, validation bounds (a rate within 0–30%, a few categories at most) and a settings card.
2. Order tax computation, the shared pricing and validation function, the hold split, and the refund share.
3. Receipts and checkout display.
4. The store's tax report, which reads its own ledger.
5. Optional rate lookup.

## Open questions for you
- **Launch region:** which states (or countries)? This decides whether prices include tax, and which delivery-fee rules matter.
- **Rates:** should stores self-declare their rate (simplest), or should the app pick it from their address (needs a rate source)?
