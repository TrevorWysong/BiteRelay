//! Menu item choices -- sizes, add-ons, sides -- as DoorDash and Uber Eats
//! model them: **choice groups** ("Milk", "Size", "Extras") a store shares
//! across its items, each with a minimum and maximum number of selections,
//! a limit per option, a number of free selections, and options that may
//! open a nested group of their own ("Side: Fries" then "Size: Large").
//!
//! One definition of what a line with choices costs and whether its choices
//! fit (`line_price`), used by the coordinator to price an order and by
//! validation to check it -- so no one can order a choice that isn't on
//! offer, skip a required one, or pay less than the menu says.
//! `web/src/lib/choices.ts` mirrors it for the item sheet's running price;
//! both are tested on the same cases.

use super::MenuItem;
use hdi::prelude::*;
use relay_integrity_support::limits::{MAX_AMOUNT, MAX_CHOICE_DEPTH, MAX_GROUP_OPTIONS, MAX_LINE_CHOICES, MAX_NAME_CHARS, MAX_OPTION_QUANTITY};
use relay_integrity_support::text_problem;

/// A store's choice group, shared by every item that lists it.
#[hdk_entry_helper]
#[derive(Clone)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct ModifierGroup {
    pub catalog_ref: ActionHash,
    /// What the customer is choosing: "Milk", "Choose a side".
    pub name: String,
    /// The fewest selections an order must make: 0 for an optional group,
    /// 1 or more for a required one.
    pub min_selections: u32,
    /// The most, counting each unit of an option; `None` for no limit
    /// beyond `max_per_option` on each.
    pub max_selections: Option<u32>,
    /// The most units of any one option ("extra shot" up to 3): 1 for a
    /// plain choice.
    pub max_per_option: u32,
    /// How many selections cost nothing: the cheapest chosen ("2 free
    /// toppings").
    pub free_selections: u32,
    pub options: Vec<ModifierOption>,
}

/// One option in a choice group.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ModifierOption {
    /// Stable within the group across its versions: what an order names.
    pub id: u32,
    pub name: String,
    /// What it adds to the item, in minor units -- 0 for no charge.
    pub price_cents: u64,
    /// Off while the store has run out: it can't be chosen.
    pub available: bool,
    /// A group the customer chooses from next when they pick this option,
    /// by its original action -- one of the same store's.
    pub nested_group: Option<ActionHash>,
}

/// What an order line chose from one choice group.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    /// The group, by its original action.
    pub group: ActionHash,
    /// The version of it the line was priced at -- the options and prices
    /// the customer saw.
    pub version: ActionHash,
    /// What was chosen, by option id, ascending.
    pub options: Vec<Chosen>,
}

/// One option chosen, how many, and what was chosen from the group it
/// opens.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Chosen {
    pub option: u32,
    pub quantity: u32,
    /// The selection from the option's nested group: exactly one if it has
    /// one, none if it doesn't.
    pub nested: Vec<Selection>,
}

/// What a customer chose from one group, before it's priced: no versions --
/// the order is priced at each group's latest (`Selection` names the one).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SelectionInput {
    pub group: ActionHash,
    pub options: Vec<ChosenInput>,
}

/// One option chosen, before pricing -- see `Chosen`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ChosenInput {
    pub option: u32,
    pub quantity: u32,
    #[serde(default)]
    pub nested: Vec<SelectionInput>,
}

/// What's wrong with choices kept to order later (a recurring order's), if
/// anything: they're bounded as an order line's are -- at most
/// `MAX_ITEM_GROUPS` groups at each level, `MAX_LINE_CHOICES` options in
/// all, `MAX_CHOICE_DEPTH` levels -- so what a customer stores stays small.
/// Whether they fit the menu is checked when the order is placed.
pub fn choices_problem(selections: &[SelectionInput]) -> Option<String> {
    fn walk(selections: &[SelectionInput], depth: usize, budget: &mut usize) -> bool {
        if depth > MAX_CHOICE_DEPTH || selections.len() > relay_integrity_support::limits::MAX_ITEM_GROUPS {
            return false;
        }
        selections.iter().all(|s| {
            s.options.iter().all(|c| {
                let fits = *budget > 0 && (1..=MAX_OPTION_QUANTITY).contains(&c.quantity);
                *budget = budget.saturating_sub(1);
                fits && walk(&c.nested, depth + 1, budget)
            })
        })
    }
    let mut budget = MAX_LINE_CHOICES;
    (!walk(selections, 1, &mut budget)).then(|| format!("an item's choices are at most {MAX_LINE_CHOICES} options, {MAX_CHOICE_DEPTH} levels deep"))
}

impl ModifierGroup {
    /// What's wrong with this group as a store defines it, if anything --
    /// apart from its nested groups being the same store's, which validation
    /// checks against the network.
    pub fn problem(&self) -> Option<String> {
        if let Some(problem) = text_problem("name", &self.name, MAX_NAME_CHARS) {
            return Some(problem);
        }
        if self.name.trim().is_empty() {
            return Some("a choice group has a name".into());
        }
        if self.options.is_empty() || self.options.len() > MAX_GROUP_OPTIONS {
            return Some(format!("a choice group has between 1 and {MAX_GROUP_OPTIONS} options"));
        }
        for (i, option) in self.options.iter().enumerate() {
            if self.options[..i].iter().any(|o| o.id == option.id) {
                return Some("each option in a group has its own id".into());
            }
            if let Some(problem) = text_problem("an option's name", &option.name, MAX_NAME_CHARS) {
                return Some(problem);
            }
            if option.name.trim().is_empty() {
                return Some("every option has a name".into());
            }
            if option.price_cents > MAX_AMOUNT {
                return Some("an option's price is at most the most any amount may be".into());
            }
        }
        if self.max_per_option == 0 || self.max_per_option > MAX_OPTION_QUANTITY {
            return Some(format!("an option may be chosen between 1 and {MAX_OPTION_QUANTITY} times"));
        }
        // Everything there is to choose, counting each unit.
        let most = self.options.len() as u32 * self.max_per_option;
        if self.min_selections > most {
            return Some("a group can't require more selections than it offers".into());
        }
        if let Some(max) = self.max_selections {
            if max == 0 || max < self.min_selections || max > most {
                return Some("a group's maximum is at least 1, at least its minimum, and at most what it offers".into());
            }
        }
        if self.free_selections > self.max_selections.unwrap_or(most) {
            return Some("a group can't give more free selections than can be chosen".into());
        }
        None
    }

    fn option(&self, id: u32) -> Option<&ModifierOption> {
        self.options.iter().find(|o| o.id == id)
    }
}

/// A choice group as of one of its versions: its original action, and it.
pub type GroupAt = (ActionHash, ModifierGroup);

/// How many options `selections` choose, nested ones included.
pub fn choice_count(selections: &[Selection]) -> usize {
    selections.iter().flat_map(|s| &s.options).map(|c| 1 + choice_count(&c.nested)).sum()
}

/// What one unit of `item` costs with `selections`, or why the selections
/// don't fit it. `group_at` reads a group version: its original action and
/// the group, or `None` if it isn't one.
///
/// The selections must be one per item group, in the item's order, each at
/// a version of that group from the item's own store; options must exist
/// in that version, be available, ascend by id, and each be chosen between
/// one and `max_per_option` times; each group's total must be within its
/// minimum and maximum; an option with a nested group carries exactly one
/// selection from it, and nesting stops at `MAX_CHOICE_DEPTH`. A line holds
/// at most `MAX_LINE_CHOICES` chosen options, so pricing it reads a bounded
/// number of groups.
///
/// The price: the item's, plus each group's chosen options -- its
/// `free_selections` cheapest units free -- plus, for each unit of an
/// option, what was chosen from its nested group.
pub fn line_price(item: &MenuItem, selections: &[Selection], group_at: &mut impl FnMut(&ActionHash) -> ExternResult<Option<GroupAt>>) -> ExternResult<Result<u64, String>> {
    let mut budget = MAX_LINE_CHOICES;
    let choices = match price_selections(&item.modifier_groups, selections, &item.catalog_ref, 1, &mut budget, group_at)? {
        Ok(cost) => cost,
        Err(reason) => return Ok(Err(reason)),
    };
    let price = u128::from(item.price_cents) + choices;
    if price > u128::from(MAX_AMOUNT) {
        return Ok(Err("an item with its choices costs at most the most any amount may be".into()));
    }
    Ok(Ok(price as u64))
}

fn price_selections(
    groups: &[ActionHash],
    selections: &[Selection],
    catalog_ref: &ActionHash,
    depth: usize,
    budget: &mut usize,
    group_at: &mut impl FnMut(&ActionHash) -> ExternResult<Option<GroupAt>>,
) -> ExternResult<Result<u128, String>> {
    if selections.len() != groups.len() || selections.iter().zip(groups).any(|(s, g)| &s.group != g) {
        return Ok(Err("a line chooses from each of its item's choice groups, in order".into()));
    }
    let mut total: u128 = 0;
    for selection in selections {
        match group_at(&selection.version)? {
            Some((original, group)) if original == selection.group && &group.catalog_ref == catalog_ref => match price_group(&group, selection, catalog_ref, depth, budget, group_at)? {
                Ok(cost) => total += cost,
                Err(reason) => return Ok(Err(reason)),
            },
            _ => return Ok(Err("a selection is priced at a version of its own choice group, from the item's store".into())),
        }
    }
    Ok(Ok(total))
}

fn price_group(
    group: &ModifierGroup,
    selection: &Selection,
    catalog_ref: &ActionHash,
    depth: usize,
    budget: &mut usize,
    group_at: &mut impl FnMut(&ActionHash) -> ExternResult<Option<GroupAt>>,
) -> ExternResult<Result<u128, String>> {
    let mut units: Vec<u64> = Vec::new();
    let mut nested_cost: u128 = 0;
    let mut previous: Option<u32> = None;
    for chosen in &selection.options {
        if previous.is_some_and(|p| p >= chosen.option) {
            return Ok(Err("a group's chosen options are listed once each, by ascending id".into()));
        }
        previous = Some(chosen.option);
        if *budget == 0 {
            return Ok(Err(format!("a line chooses at most {MAX_LINE_CHOICES} options")));
        }
        *budget -= 1;
        let Some(option) = group.option(chosen.option).filter(|o| o.available) else {
            return Ok(Err(format!("a choice in {} isn't on offer any more", group.name)));
        };
        if chosen.quantity == 0 || chosen.quantity > group.max_per_option {
            return Ok(Err(format!("{} may be chosen between 1 and {} times", option.name, group.max_per_option)));
        }
        units.extend(std::iter::repeat_n(option.price_cents, chosen.quantity as usize));
        match &option.nested_group {
            // Too deep to choose from: the option can't be chosen here.
            Some(_) if depth >= MAX_CHOICE_DEPTH => return Ok(Err(format!("choices nest at most {MAX_CHOICE_DEPTH} levels deep"))),
            Some(nested) => match price_selections(std::slice::from_ref(nested), &chosen.nested, catalog_ref, depth + 1, budget, group_at)? {
                Ok(cost) => nested_cost += cost * u128::from(chosen.quantity),
                Err(reason) => return Ok(Err(reason)),
            },
            None if !chosen.nested.is_empty() => return Ok(Err(format!("{} has nothing more to choose", option.name))),
            None => {}
        }
    }
    let count = units.len() as u32;
    if count < group.min_selections || group.max_selections.is_some_and(|max| count > max) {
        let range = match group.max_selections {
            Some(max) if max == group.min_selections => format!("exactly {max}"),
            Some(max) => format!("between {} and {max}", group.min_selections),
            None => format!("at least {}", group.min_selections),
        };
        return Ok(Err(format!("{}: choose {range}", group.name)));
    }
    units.sort_unstable();
    let charged: u128 = units.iter().skip(group.free_selections as usize).map(|&p| u128::from(p)).sum();
    Ok(Ok(charged + nested_cost))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn hash(n: u8) -> ActionHash {
        ActionHash::from_raw_36(vec![n; 36])
    }
    const STORE: u8 = 200;

    fn option(id: u32, price_cents: u64) -> ModifierOption {
        ModifierOption { id, name: format!("option {id}"), price_cents, available: true, nested_group: None }
    }

    fn group(name: &str, min: u32, max: Option<u32>, free: u32, options: Vec<ModifierOption>) -> ModifierGroup {
        ModifierGroup { catalog_ref: hash(STORE), name: name.into(), min_selections: min, max_selections: max, max_per_option: 1, free_selections: free, options }
    }

    fn item(price_cents: u64, groups: &[u8]) -> MenuItem {
        MenuItem {
            catalog_ref: hash(STORE),
            name: "Latte".into(),
            price_cents,
            available: true,
            description: String::new(),
            photo_data_uri: String::new(),
            category: String::new(),
            dietary_tags: Vec::new(),
            modifier_groups: groups.iter().map(|&g| hash(g)).collect(),
            tax_category: String::new(),
        }
    }

    /// Groups by number: each is its own only version.
    struct Menu(BTreeMap<u8, ModifierGroup>);

    impl Menu {
        fn price(&self, item: &MenuItem, selections: &[Selection]) -> Result<u64, String> {
            line_price(item, selections, &mut |version: &ActionHash| Ok(self.0.iter().find(|(n, _)| &hash(**n) == version).map(|(n, g)| (hash(*n), g.clone())))).unwrap()
        }
    }

    fn pick(group: u8, options: &[(u32, u32)]) -> Selection {
        Selection { group: hash(group), version: hash(group), options: options.iter().map(|&(option, quantity)| Chosen { option, quantity, nested: Vec::new() }).collect() }
    }

    // Each case also runs in web/test/choices.test.ts -- keep them in step.
    #[test]
    fn a_required_choice_adds_its_price() {
        let menu = Menu(BTreeMap::from([(1, group("Size", 1, Some(1), 0, vec![option(1, 0), option(2, 75)]))]));
        assert_eq!(menu.price(&item(400, &[1]), &[pick(1, &[(2, 1)])]), Ok(475));
        assert!(menu.price(&item(400, &[1]), &[pick(1, &[])]).unwrap_err().contains("choose exactly 1"));
        assert!(menu.price(&item(400, &[1]), &[pick(1, &[(1, 1), (2, 1)])]).is_err());
    }

    #[test]
    fn every_group_is_answered_in_order() {
        let menu = Menu(BTreeMap::from([(1, group("Size", 0, None, 0, vec![option(1, 0)])), (2, group("Milk", 0, None, 0, vec![option(1, 0)]))]));
        assert_eq!(menu.price(&item(400, &[1, 2]), &[pick(1, &[]), pick(2, &[])]), Ok(400));
        assert!(menu.price(&item(400, &[1, 2]), &[pick(1, &[])]).is_err(), "a group left out");
        assert!(menu.price(&item(400, &[1, 2]), &[pick(2, &[]), pick(1, &[])]).is_err(), "out of order");
        assert!(menu.price(&item(400, &[1]), &[pick(2, &[])]).is_err(), "a group the item doesn't offer");
    }

    #[test]
    fn the_cheapest_choices_are_the_free_ones() {
        let menu = Menu(BTreeMap::from([(1, group("Toppings", 0, Some(4), 2, vec![option(1, 100), option(2, 50), option(3, 200)]))]));
        assert_eq!(menu.price(&item(1000, &[1]), &[pick(1, &[(1, 1), (2, 1), (3, 1)])]), Ok(1200), "50 and 100 free, 200 charged");
        assert_eq!(menu.price(&item(1000, &[1]), &[pick(1, &[(3, 1)])]), Ok(1000));
    }

    #[test]
    fn an_option_chosen_several_times_counts_each() {
        let mut shots = group("Extra shots", 0, Some(3), 0, vec![option(1, 80)]);
        shots.max_per_option = 3;
        let menu = Menu(BTreeMap::from([(1, shots)]));
        assert_eq!(menu.price(&item(400, &[1]), &[pick(1, &[(1, 3)])]), Ok(640));
        assert!(menu.price(&item(400, &[1]), &[pick(1, &[(1, 4)])]).is_err());
        assert!(menu.price(&item(400, &[1]), &[pick(1, &[(1, 0)])]).is_err());
    }

    #[test]
    fn options_are_listed_once_ascending_and_must_be_on_offer() {
        let mut milk = group("Milk", 0, None, 0, vec![option(1, 0), option(2, 60)]);
        milk.options[1].available = false;
        let menu = Menu(BTreeMap::from([(1, milk)]));
        assert!(menu.price(&item(400, &[1]), &[pick(1, &[(2, 1)])]).is_err(), "sold out");
        assert!(menu.price(&item(400, &[1]), &[pick(1, &[(9, 1)])]).is_err(), "no such option");
        assert!(menu.price(&item(400, &[1]), &[pick(1, &[(1, 1), (1, 1)])]).is_err(), "listed twice");
    }

    #[test]
    fn a_nested_choice_is_priced_per_unit_of_its_option() {
        let mut side = option(1, 150);
        side.nested_group = Some(hash(2));
        let menu = Menu(BTreeMap::from([(1, group("Side", 1, Some(1), 0, vec![side])), (2, group("Size", 1, Some(1), 0, vec![option(1, 0), option(2, 100)]))]));
        let nested = |size: u32| Selection { group: hash(1), version: hash(1), options: vec![Chosen { option: 1, quantity: 1, nested: vec![pick(2, &[(size, 1)])] }] };
        assert_eq!(menu.price(&item(900, &[1]), &[nested(2)]), Ok(1150));
        assert!(menu.price(&item(900, &[1]), &[pick(1, &[(1, 1)])]).is_err(), "the nested group must be answered");
    }

    #[test]
    fn nesting_stops_at_the_depth_limit() {
        // A group whose option opens the same group: a loop, cut off.
        let mut again = option(1, 0);
        again.nested_group = Some(hash(1));
        let menu = Menu(BTreeMap::from([(1, group("Loop", 0, None, 0, vec![again]))]));
        let mut selection = pick(1, &[]);
        for _ in 0..MAX_CHOICE_DEPTH {
            selection = Selection { group: hash(1), version: hash(1), options: vec![Chosen { option: 1, quantity: 1, nested: vec![selection] }] };
        }
        assert!(menu.price(&item(100, &[1]), &[selection]).unwrap_err().contains("nest"));
    }

    #[test]
    fn a_group_from_another_store_is_refused() {
        let mut other = group("Size", 0, None, 0, vec![option(1, 0)]);
        other.catalog_ref = hash(201);
        let menu = Menu(BTreeMap::from([(1, other)]));
        assert!(menu.price(&item(400, &[1]), &[pick(1, &[])]).is_err());
    }

    #[test]
    fn a_line_holds_a_bounded_number_of_choices() {
        let options: Vec<_> = (1..=MAX_GROUP_OPTIONS as u32).map(|id| option(id, 0)).collect();
        let menu = Menu(BTreeMap::from([(1, group("A", 0, None, 0, options.clone())), (2, group("B", 0, None, 0, options))]));
        let all = |g: u8| pick(g, &(1..=MAX_GROUP_OPTIONS as u32).map(|id| (id, 1)).collect::<Vec<_>>());
        assert!(menu.price(&item(100, &[1, 2]), &[all(1), all(2)]).unwrap_err().contains("at most"));
    }

    #[test]
    fn a_group_must_make_sense() {
        assert_eq!(group("Size", 1, Some(1), 0, vec![option(1, 0)]).problem(), None);
        assert!(group("Size", 2, Some(1), 0, vec![option(1, 0), option(2, 0)]).problem().is_some(), "min above max");
        assert!(group("Size", 3, None, 0, vec![option(1, 0), option(2, 0)]).problem().is_some(), "requires more than it offers");
        assert!(group("Size", 0, Some(1), 2, vec![option(1, 0), option(2, 0)]).problem().is_some(), "more free than can be chosen");
        assert!(group("Size", 0, None, 0, vec![option(1, 0), option(1, 0)]).problem().is_some(), "duplicate ids");
        assert!(group("Size", 0, None, 0, vec![]).problem().is_some(), "no options");
    }
}
