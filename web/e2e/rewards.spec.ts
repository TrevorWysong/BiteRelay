// A store's rewards program end to end in the browser, against the seeded
// world: the café runs one (scripts/lib/world.ts). Its owner sees the
// builder with the card drawn live; a customer sees it on the store's page,
// in their Rewards, and at checkout. Set SCREENSHOTS=<dir> to keep a picture
// of each screen.
import { expect, test, type Page } from "@playwright/test";
import { signInAs, store } from "./seed.ts";

const shoot = async (page: Page, name: string) => {
  if (!process.env.SCREENSHOTS) return;
  // Past the route's transition and the card's count-up.
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}.png` });
};

test("a store's owner builds its rewards program, with its card drawn live", async ({ page }) => {
  await signInAs(page, "cara");
  await page.getByRole("link", { name: "Rewards" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Rewards" })).toBeVisible();
  await expect(page.getByText("Café Club").first()).toBeVisible();
  await expect(page.getByText("Free Almond Croissant").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await shoot(page, "merchant-rewards");
  await page.locator('input[maxlength="40"]').first().fill("Café Club+");
  await expect(page.getByText("Café Club+").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled();
});

test("a customer finds a store's program on its page, in Rewards, and at checkout", async ({ page }) => {
  const cafe = store("cafe");
  await signInAs(page, "lee");
  await page.getByText(cafe.name, { exact: true }).first().click();
  const strip = page.getByRole("button", { name: /Café Club|beans/ }).first();
  await expect(strip).toBeVisible();
  await shoot(page, "store-strip");
  await strip.click();
  await expect(page.getByText("How you earn")).toBeVisible();
  await expect(page.getByText("Free Latte").first()).toBeVisible();
  await expect(page.getByText("Platinum").first()).toBeVisible();
  await shoot(page, "rewards-detail");

  // At checkout -- while the café's open (07:00-18:00): a closed store's
  // items can't be added, and the app's clock can't be faked, since zome
  // calls are signed with the real time.
  await page.getByRole("button", { name: `Order from ${cafe.name}` }).click();
  const add = page.getByRole("button", { name: "Add Almond Croissant" });
  if (await add.isEnabled()) {
    await add.click();
    await page.getByRole("link", { name: "Cart" }).click();
    await expect(page.getByText(/You'll earn \d+ beans/)).toBeVisible();
    await expect(page.getByText("Café Club").first()).toBeVisible();
    await shoot(page, "cart-rewards");
  }

  await page.getByRole("link", { name: "Rewards" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Rewards" })).toBeVisible();
  await expect(page.getByText("Your birthday")).toBeVisible();
  await shoot(page, "rewards-wallet");
});
