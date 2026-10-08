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

test("a store sees new orders waiting for it to accept or decline", async ({ page }) => {
  // Mo's stores each have a seeded order waiting on them. Read-only, so
  // the seeded world stays as it is for the next run.
  await signInAs(page, "mo");
  // Mo also orders and drives, so switch to the store side.
  await page.getByRole("button", { name: "Sell" }).click();
  await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept order" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline" }).first()).toBeVisible();
});

test("a driver goes online and sees the nearby order feed", async ({ page }) => {
  await signInAs(page, "dana");

  await expect(page.getByText("You're offline")).toBeVisible();
  await page.getByRole("button", { name: "Go online" }).click();
  await expect(page.getByText("You're online")).toBeVisible();
  await expect(page.getByText("Nearby open orders")).toBeVisible();
});
