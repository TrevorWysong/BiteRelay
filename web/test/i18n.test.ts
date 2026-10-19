// Every translation has every message, with the same placeholders, and
// plural messages have the forms their language needs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { en, type Message } from "../src/i18n/en";
import { es } from "../src/i18n/es";
import { format, negotiate } from "../src/i18n";

const catalogs = { es };

const placeholders = (m: Message) =>
  [...new Set((typeof m === "string" ? [m] : Object.values(m)).flatMap((text) => [...(text ?? "").matchAll(/\{(\w+)\}/g)].map((x) => x[1])))].sort();

for (const [locale, catalog] of Object.entries(catalogs)) {
  test(`${locale}: every message, with the same placeholders`, () => {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      assert.deepEqual(placeholders(catalog[key]), placeholders(en[key]), `${locale} ${key}`);
      const english = en[key];
      if (typeof english !== "string") {
        const forms = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
        const message = catalog[key];
        assert.ok(typeof message !== "string", `${locale} ${key} counts something`);
        for (const form of forms) assert.ok(form === "other" || form in message || "other" in message, `${locale} ${key}: ${form}`);
      }
    }
  });
}

test("placeholders and plurals fill in", () => {
  assert.equal(format("en", en["appeal.storeWaiting"], { count: 1 }), "A customer appealed your decision");
  assert.equal(format("en", en["appeal.storeWaiting"], { count: 3 }), "3 customers appealed your decisions");
  assert.equal(format("es", es["appeal.awarded"], { amount: "5 €" }), "El árbitro concedió 5 €");
});

test("a device's languages pick the closest translation, else English", () => {
  assert.equal(negotiate(["es-MX", "en-US"]), "es");
  assert.equal(negotiate(["fr-FR", "es"]), "es");
  assert.equal(negotiate(["fr-FR"]), "en");
  assert.equal(negotiate([]), "en");
});
