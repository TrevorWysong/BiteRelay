// One pass through each role's main screens against the seeded world --
// enough to catch a broken route, a failing zome read, or a page that never
// leaves its loading state. Behavior in depth lives in the Tryorama suite.
import { expect, test } from "@playwright/test";
import { signInAs, store } from "./seed.ts";

test("a customer browses nearby stores, opens a menu, and sees their orders", async ({ page }) => {
  const kitchen = store("kitchen");
  await signInAs(page, "sam");

  await expect(page.getByRole("heading", { name: "Restaurants near you" })).toBeVisible();
  await page.getByText(kitchen.name, { exact: true }).first().click();
  await expect(page.getByText(kitchen.menu[0].name).first()).toBeVisible();

  await page.getByRole("link", { name: "Orders" }).click();
  await expect(page.getByRole("heading", { name: "Your orders" })).toBeVisible();
  // Sam's seeded delivery is still waiting for a driver.
  await expect(page.getByText("No orders in progress")).toHaveCount(0);
  await expect(page.locator('a[href*="/customer/orders/"]').first()).toBeVisible();

  await page.getByRole("tab", { name: "Past" }).click();
  await expect(page.getByRole("tab", { name: "Past", selected: true })).toBeVisible();
});

test("a merchant sees their order queue and manages their menu and promos", async ({ page }) => {
  const cafe = store("cafe");
  await signInAs(page, "cara");

  await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByRole("tab", { name: "History", selected: true })).toBeVisible();

  await page.getByRole("link", { name: "Menu" }).click();
  await expect(page.getByRole("heading", { name: cafe.name })).toBeVisible();
  await expect(page.getByText(cafe.menu[0].name).first()).toBeVisible();
  await expect(page.getByText(cafe.promos![0].code)).toBeVisible();
});

test("a customer's order waits on the store, which can accept or decline it", async ({ page }) => {
  const tacos = store("tacos");
  await signInAs(page, "ana");
  await page.getByText(tacos.name, { exact: true }).first().click();
  await page.getByRole("button", { name: `Add ${tacos.menu[0].name}` }).click();
  await page.getByRole("link", { name: "Cart" }).click();
  await page.getByText("Pickup", { exact: true }).click();
  await page.getByRole("button", { name: /Place pickup order/ }).click();
  await expect(page.getByText(/Waiting for the store to accept your order/)).toBeVisible();
  await expect(page.getByText(/The store has until \d{1,2}:\d{2}/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel order" })).toBeVisible();

  // Mo runs Mo's Tacos; he also orders and drives, so switch to the store side.
  await signInAs(page, "mo");
  await page.getByRole("button", { name: "Sell" }).click();
  await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Accept · \d+ min$/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline" }).first()).toBeVisible();
  await expect(page.getByText(/Accept by \d{1,2}:\d{2}/).first()).toBeVisible();
});

test("a driver goes online and sees the nearby order feed", async ({ page }) => {
  await signInAs(page, "dana");

  await expect(page.getByText("You're offline")).toBeVisible();
  await page.getByRole("button", { name: "Go online" }).click();
  await expect(page.getByText("You're online")).toBeVisible();
  // Nearby orders -- or, with deliveries already on, add-ons on the way.
  await expect(page.getByText(/^(Nearby open orders|Add-ons on your way)$/)).toBeVisible();
});
