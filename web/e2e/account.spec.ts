// Moving an account to a new phone, and recovering it with the recovery
// phrase -- each as two devices (two browser contexts) on the dev
// conductor, through the real screens. The rules themselves are proved in
// tests/tryorama/src/device-move.test.ts and account.test.ts.
import { expect, test, type Browser, type Page } from "@playwright/test";

/// A fresh device: its own browser storage, with a platform authenticator
/// that says yes, so passkey setup doesn't wait on a prompt.
async function newDevice(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  return page;
}

/// Signs up as a new customer called `name`.
async function signUp(page: Page, name: string) {
  await page.goto("/#/onboarding");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("Alex Rivera").fill(name);
  await page.getByRole("button", { name: "Enter Relay" }).click();
  await expect(page).toHaveURL(/#\/customer/);
}

async function openAccount(page: Page) {
  await page.goto("/#/account");
  await expect(page.getByRole("heading", { name: "Account & recovery" })).toBeVisible();
}

/// Starts "I already have an account" on a new device, by `method`.
async function startRestore(page: Page, method: RegExp) {
  await page.goto("/#/onboarding");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.getByRole("button", { name: method }).click();
}

/// The code a device shows, as its copy button copies it.
async function copiedCode(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Copy the code instead" }).click();
  // Run in the page, where there's a clipboard to read.
  return page.evaluate<string>("navigator.clipboard.readText()");
}

test("moving to a new phone brings the same account over, and the old phone lets it go", async ({ browser }) => {
  test.setTimeout(240_000);
  const name = `Mover ${Date.now() % 100_000}`;
  const oldPhone = await newDevice(browser);
  await signUp(oldPhone, name);

  // The new phone invites; the old one checks the code, waits for the
  // network, stops, and shows its key sealed to the new one.
  const newPhone = await newDevice(browser);
  await startRestore(newPhone, /From my other phone/);
  await expect(newPhone.getByRole("heading", { name: "Show this to your old phone" })).toBeVisible();
  const invitation = await copiedCode(newPhone);

  await openAccount(oldPhone);
  await oldPhone.getByRole("button", { name: /Move to a new phone/ }).click();
  await oldPhone.getByRole("button", { name: "Paste the code instead" }).click();
  await oldPhone.getByPlaceholder("relay-move:1:…").fill(invitation);
  await oldPhone.getByRole("button", { name: "Continue" }).click();
  await oldPhone.getByRole("button", { name: "Move my account" }).click();
  await expect(oldPhone.getByRole("heading", { name: "Scan this with your new phone" })).toBeVisible({ timeout: 90_000 });
  const sealed = await copiedCode(oldPhone);

  // The new phone takes it in, restores the account, and opens as it --
  // the same account, so nothing to confirm (once unlocked: it set up its
  // own passkey).
  await newPhone.getByRole("button", { name: "My old phone scanned it" }).click();
  await newPhone.getByRole("button", { name: "Paste the code instead" }).click();
  await newPhone.getByPlaceholder("relay-key:1:…").fill(sealed);
  await newPhone.getByRole("button", { name: "Continue" }).click();
  await newPhone.getByRole("button", { name: "Unlock Relay" }).click({ timeout: 150_000 });
  await expect(newPhone).toHaveURL(/#\/customer/);
  await newPhone.goto("/#/profile");
  await expect(newPhone.getByText(name).first()).toBeVisible();

  // The old phone lets go, and keeps nothing.
  await oldPhone.getByRole("button", { name: "My new phone has my account" }).click();
  await oldPhone.getByRole("button", { name: "Remove it from this phone" }).click();
  await expect(oldPhone).toHaveURL(/#\/onboarding/);
});

test("a recovery phrase brings an account back on a new device", async ({ browser }) => {
  test.setTimeout(180_000);
  const lost = await newDevice(browser);
  await signUp(lost, `Forgetful ${Date.now() % 100_000}`);
  await openAccount(lost);
  await lost.getByRole("button", { name: /Recovery phrase/ }).click();
  await lost.getByRole("button", { name: "Show my words" }).click();
  const words = await lost.locator("ol li span.font-mono").allTextContents();
  expect(words).toHaveLength(12);
  await lost.getByRole("button", { name: "I've written them down" }).click();
  for (const label of await lost.getByText(/^Word \d+$/).allTextContents()) {
    const position = Number(label.replace("Word ", "")) - 1;
    await lost.getByLabel(label, { exact: true }).fill(words[position]);
  }
  await lost.getByRole("button", { name: "Turn on my recovery phrase" }).click();
  await expect(lost.getByText("You can get your account back")).toBeVisible();

  const found = await newDevice(browser);
  await startRestore(found, /With my recovery phrase/);
  await found.getByPlaceholder("word word word …").fill(words.join(" "));
  await found.getByRole("button", { name: "Recover my account" }).click();
  await expect(found.getByRole("heading", { name: "Your account is here" })).toBeVisible({ timeout: 60_000 });
  // A customer's name was sealed to the lost key: they type it again.
  await found.getByPlaceholder("Alex Rivera").fill("Forgetful again");
  await found.getByRole("button", { name: "Enter Relay" }).click();
  await expect(found).toHaveURL(/#\/customer/);

  await lost.reload();
  await lost.getByRole("button", { name: "Unlock Relay" }).click();
  await expect(lost.getByRole("heading", { name: "Your account has moved" })).toBeVisible({ timeout: 30_000 });
});
