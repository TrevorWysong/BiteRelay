# Menu item customization: a plan

Sizes, add-ons, choices and nested options ("Large, oat milk, extra shot, vanilla: light"), priced and checked so neither the customer nor the store can change what an order costs. Research and a proposed design.

## What the big apps do

DoorDash's menu builder, like Square's item modifiers, uses **modifier groups** attached to items:
- **Require a selection:** the customer must pick at least the group's minimum to add the item.
- **Minimum and maximum selections** per group ("Choose up to 3", "No max").
- **Maximum free:** the first *n* options in a group are free, whatever their price ("2 free toppings").
- **Nested modifiers:** an option opens its own group (a syrup, then "light / standard / extra").
- **Shared groups:** one group ("Choose a side") is reused across many items.

([DoorDash: editing modifier settings](https://help.doordash.com/en-au/merchants/article/editing-modifier-settings-on-your-menu), [DoorDash: adding modifiers](https://merchants.doordash.com/en-ca/learning-center/modifiers), [Square: item modifiers](https://squareup.com/help/us/en/article/5119-item-modifiers))

## Where Relay is today

- **Menu items:** a `MenuItem` has a name, price, availability, description, photo, category and dietary tags. There are no options.
- **Order lines:** an `OrderLine` is `{ item_ref, priced_version, quantity }`. Validation recomputes the order total from each line's priced version, and promotions, refunds for missing items, loyalty and receipts all build on that.
- **Free text:** customization today is only a free-text kitchen note, sealed to the store. It's unpriced and can't be checked.

## Recommended design

### Data model
**`ModifierGroup`**: a catalog entry, so groups are shared across items and versioned like items.
- `catalog_ref`, `name` ("Milk", "Size", "Extras");
- `min_selections`, `max_selections` (`None` = no max), `free_selections`;
- `options`: a list of `ModifierOption { id, name, price_cents, available, nested_group: Option<group ref> }`, where `id` is a small stable number within the group.

**`MenuItem` gains `modifier_groups`**: a list of group references (their original actions), in display order.

**`OrderLine` gains `choices`**: a list of `Choice { group, group_version, option_id, quantity, nested }`.
- `group_version` pins the price the customer saw, exactly as `priced_version` does for items, so a menu change doesn't change an order in flight. The existing price-change grace applies.
- `nested` holds the choices inside a chosen option's nested group.

### Validation
All of it is deterministic and bounded.
- **Choices fit the groups:** each choice's group is one of that item's groups, or the nested group of its parent option. Each group's choices satisfy its minimum and maximum, and a required group always has its minimum.
- **Options are real:** each option exists in that group version and is available.
- **Price:** a line's unit price = item price + Σ chosen option prices, where the group's `free_selections` cheapest *chosen* options cost nothing. Choosing the cheapest as free is deterministic and matches how stores usually mean it. The order total is Σ unit price × quantity, after promotions, as now.
- **Bounds against abuse:** at most 10 groups per item, 30 options per group, one level of nesting, and 50 choices per line. These are new constants in `limits.rs`, exported to the web like the others.
- **Same-store rule:** a group belongs to the same store as the item. Item and group writes are checked as catalog links are today.

### Effects on the rest of the app
- **Kitchen:** order cards and the printable ticket list choices under each line ("+ Oat milk, Extra shot (2)").
- **Missing-item reports:** a report names the line, not just the item, so "the large latte with oat milk" is refunded at that line's full price. `claimed_value` uses line unit prices.
- **Promotions:** item-based promotions (buy X get Y) keep matching on `item_ref`, whatever the choices. A "free item" reward covers the base item, with paid choices still charged. That's the common store expectation, and it should be stated in the promotion's description.
- **Loyalty and ratings:** unchanged, since they're keyed by item.
- **Goodie bags:** no modifiers.
- **Out of stock:** marking an option unavailable hides it from new orders.
- **Taxes:** each choice inherits its item's tax category (see `SALES_TAX.md`).

### Screens
- **Store, "Menu":** a "Choices" section to create groups (required toggle, minimum, maximum and free counts, options with prices and nested groups) and attach them to items. A preview shows what customers will see.
- **Customer, item sheet:**
  - groups as radio buttons (when the maximum is 1) or checkboxes, plus quantity steppers where an option can be chosen more than once;
  - "Required" badges, a running price, and the add button disabled until required groups are met;
  - nested groups expanding under their option.
- **Cart:** a line's choices and its unit price; editing a line reopens the sheet.

## What to build
1. Types, validation and limits: `ModifierGroup`, item references, line choices, and price recomputation in the shared pricing function. Unit tests for the price and min/max rules, including free selections and nesting.
2. Catalog coordinator functions to create, update and attach groups, plus the price-change grace for group versions.
3. Order placement and pricing, receipts, kitchen display, and reports for missing items by line.
4. Web: the store's group editor, the customer's item sheet, and cart editing.
5. Integration tests:
   - an order whose choices don't fit their groups is refused;
   - a forged line price is refused;
   - an order priced from an old group version is honoured within the grace period, then declined.

## Open questions for you
- **Nesting depth:** is one level enough (the most common), or are two needed for things like combo meals (a combo, then a side, then that side's size)?
- **Free selections:** should "free" apply to the cheapest chosen options (recommended), or to the first chosen?
- **Kitchen note:** keep the free-text note alongside structured choices? DoorDash keeps "special instructions"; the recommendation is to keep it.
