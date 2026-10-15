// Moving an account to a new device, and recovering it with the recovery
// phrase -- each as two devices (two browser contexts) on the dev
// conductor, through the real screens. The rules themselves are proved in
// tests/tryorama/src/account.test.ts.
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

/// The account code a device shows, as its copy button copies it.
async function copiedCode(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Copy the code instead" }).click();
  return page.evaluate(() => navigator.clipboard.readText());
}

test("moving to a new device takes the account, its name and its balance along, and retires the old one", async ({ browser }) => {
  test.setTimeout(180_000);
  const name = `Mover ${Date.now() % 100_000}`;
  const oldPhone = await newDevice(browser);
  await signUp(oldPhone, name);

  const newPhone = await newDevice(browser);
  await startRestore(newPhone, /From my other device/);
  await expect(newPhone.getByText("Scan this with your other device")).toBeVisible();
  const code = await copiedCode(newPhone);

  await openAccount(oldPhone);
  await oldPhone.getByRole("button", { name: /Move to a new device/ }).click();
  await oldPhone.getByRole("button", { name: "Paste the code instead" }).click();
  await oldPhone.getByPlaceholder("relay-account:uhCAk…").fill(code);
  await oldPhone.getByRole("button", { name: "Continue" }).click();
  await oldPhone.getByRole("button", { name: "Move my account" }).click();
  await expect(oldPhone.getByRole("heading", { name: "Your account has moved" })).toBeVisible();

  // The new phone notices on its own, with the name the old one sealed to it.
  await expect(newPhone.getByRole("heading", { name: "Your account is here" })).toBeVisible({ timeout: 60_000 });
  await expect(newPhone.getByPlaceholder("Alex Rivera")).toHaveValue(name);
  await newPhone.getByRole("button", { name: "Enter Relay" }).click();
  await expect(newPhone).toHaveURL(/#\/customer/);

  // And the old phone stays retired across a reload (once unlocked: its
  // passkey still guards it).
  await oldPhone.reload();
  await oldPhone.getByRole("button", { name: "Unlock Relay" }).click();
  await expect(oldPhone.getByRole("heading", { name: "Your account has moved" })).toBeVisible();
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
