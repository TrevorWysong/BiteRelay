# Tax reporting: a plan

What stores, drivers and customers need at tax time, and what forms anyone may owe, when payments go peer to peer. Research and a proposed design. This is not tax advice; a tax professional should confirm the obligations, especially the store-to-driver form below.

## The forms that matter (US, 2026)

- **Form 1099-K**, filed by payment settlement entities: card processors and third-party payment networks such as Stripe or PayPal.
  - **Threshold:** for 2025 and 2026 it's back to **more than $20,000 and more than 200 transactions** after the One Big Beautiful Bill Act repealed the $600 rule ([TaxAct](https://blog.taxact.com/4-common-misconceptions-about-the-new-1099-k-reporting-threshold/), [Credit Karma](https://www.creditkarma.com/tax/library/irs-forms/1099-k-threshold/)).
  - **Card payments** have no threshold for the processor.
- **Form 1099-NEC**, filed by a *business* paying an independent contractor for services. From payments made in 2026, the threshold rises from $600 to **$2,000**, adjusted for inflation from 2027 ([DoorDash's Dasher tax guide](https://help.doordash.com/en-us/dashers/article/common-dasher-tax-questions), [Keeper](https://wf.keepertax.com/posts/doordash-1099)).
  - DoorDash issues these to Dashers through Stripe Express.
- **Below every threshold, income is still taxable.** Drivers and stores must report all of it, which is why their records matter more than the forms.

## Who files what in HandShake

There's no platform paying anyone, so the platform-shaped obligations land differently:

| Payment | Payer | Form | Who files |
|---|---|---|---|
| Customer → driver (fee share, tip) | A person buying a delivery for themselves | None: personal payments aren't reportable by the payer | Nobody; the driver reports the income |
| Customer → store (food) | A person buying food | None | Nobody; the store reports its sales |
| **Store → driver (store's fee share, late-store pay)** | **A business paying a contractor for delivery** | **1099-NEC if ≥ $2,000 to one driver in the year** | **The store** |
| Issuer payouts to stores and drivers | The issuer, through its payment processor | 1099-K if over $20,000 and 200 payments | The processor (e.g. Stripe, under Connect), not HandShake |

The store-to-driver row is the new one. A store that subsidises deliveries is paying drivers for a service. Paying any one driver $2,000 or more in a year would make it the 1099-NEC filer. Most stores won't cross that with any single driver, but the app should tell them when they do.

## What the app should provide

All of it is computed **on each person's own device, from their own ledger chain**. Nobody's earnings are compiled anywhere else, which keeps the privacy model intact.

**Drivers: "Earnings & taxes"**
- **Totals by year:** delivery fees, tips, late-store pay from stores, and collateral forfeited.
  - The forfeit is a loss to discuss with an adviser.
  - Collateral held and returned isn't income and is left out.
- **Breakdown:** per month, and per store paying a fee share (what each store would report on a 1099-NEC).
- **Mileage:** an opt-in mileage log, since mileage is the largest deduction for most drivers. It counts trip distances (driver to store to drop-off) from the app's own estimates or GPS while on a delivery, and stays on the device.
- **Export:** CSV and a printable PDF summary.

**Stores: "Sales & taxes"**
- **Sales:** gross food sales, refunds (missing items, not-delivered), net sales, and orders kept as not collected.
- **Sales tax:** tax collected by rate and category, per filing period (monthly, quarterly or annual) for the store's sales-tax return (see `SALES_TAX.md`).
- **Driver payments:** delivery fee share and late-store pay per driver, with a flag for drivers at or near the 1099-NEC threshold.
- **Export:** CSV in a shape accountants and bookkeeping tools import (date, order, gross, tax, refunds, fees, net).

**Customers**
- A receipts archive (already exists) and a yearly spend export, which is useful for business expenses.

## Collecting a driver's tax details, if a store needs them

A 1099-NEC needs the driver's legal name, address and taxpayer ID (from a W-9). HandShake should never publish these.
1. When a store's payments to one driver approach the threshold, the store's app asks that driver's app.
2. The driver fills in a W-9 form in their app. It's **sealed to that store only**, the same way addresses are sealed to a driver today.
3. The store's report includes it. Nothing goes on the public network beyond the sealed copy.

**Alternative:** if payouts run through Stripe Connect (see `CARD_PAYMENTS.md`), Stripe already holds each driver's tax details from onboarding. A store could file through a 1099 service using those, and never hold the driver's taxpayer ID itself.

## What to build
1. A shared "statement" module computing yearly and periodic totals from a person's own ledger entries and order records. Pure functions with unit tests, used by both reports.
2. The driver's Earnings & taxes screen, CSV and PDF export, and the opt-in mileage log.
3. The store's Sales & taxes screen, its sales-tax period report (after `SALES_TAX.md`), driver-payment totals and the threshold flag.
4. Sealed W-9 exchange between a store and a driver, if stores will file 1099s themselves.
5. Copy on the policies page about who files what.

## Open questions for you
- **Store-to-driver payments:** keep the store's fee share, which creates the store-to-driver 1099 obligation? The alternative is routing all driver pay through the customer, which removes it but changes the fee model.
- **Mileage tracking:** should GPS mileage be in v1, or estimated distances only?
- **Region:** any non-US launch region? VAT and income reporting differ entirely (for example the EU's DAC7 rules for platforms).
