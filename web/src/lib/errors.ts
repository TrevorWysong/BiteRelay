// What went wrong, as a sentence in the person's language.
//
// Holochain zome-call failures surface as raw Wasm/Ribosome runtime traces,
// e.g. `Wasm runtime error while working with Ribosome: RuntimeError:
// dispatch::orders:412: Guest("This order isn't taking offers any more.")`.
// The only part meant for a human is the text inside Guest(...). A refusal
// a person can meet -- from a zome, the device runtime or the issuer -- is
// in the generated table (`i18n/refusals.ts`), written in English by its
// source: it's shown translated, its values filled back in (an amount,
// named `..._cents`, in the network's currency). A zome's lowercase
// message is a diagnostic, not a sentence for people: it's shown as
// something having gone wrong, with the detail kept for support.
import { REFUSALS } from "../i18n/refusals";
import { t } from "../i18n";
import { formatCents } from "./format";

type RefusalKey = keyof typeof REFUSALS;

/// Each refusal by its exact text, and those with values as patterns that
/// read the values back.
const exact = new Map<string, RefusalKey>();
const patterns: { key: RefusalKey; names: string[]; pattern: RegExp }[] = [];
for (const [key, english] of Object.entries(REFUSALS) as [RefusalKey, string][]) {
  const names = [...english.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  if (names.length === 0) {
    exact.set(english, key);
    continue;
  }
  const literal = english.split(/\{\w+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  patterns.push({ key, names, pattern: new RegExp(`^${literal.join("(.+?)")}$`) });
}

/// `text` in the person's language, if it's a known refusal.
function translated(text: string): string | null {
  const key = exact.get(text);
  if (key) return t(key);
  for (const { key, names, pattern } of patterns) {
    const values = text.match(pattern);
    if (!values) continue;
    const vars: Record<string, string> = {};
    names.forEach((name, i) => {
      const value = values[i + 1];
      vars[name] = name.endsWith("_cents") && /^\d+$/.test(value) ? formatCents(Number(value)) : value;
    });
    return t(key, vars);
  }
  return null;
}

export function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const guest = raw.match(/Guest\("((?:[^"\\]|\\.)*)"\)/);
  if (!guest) return translated(raw) ?? raw;
  const text = guest[1].replace(/\\"/g, '"').replace(/\\n/g, " ");
  return translated(text) ?? (/^[a-z]/.test(text) ? t("error.unexpected", { detail: text }) : text);
}
