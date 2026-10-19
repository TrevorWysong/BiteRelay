// What every language's policies share: their shape, and how durations are
// said.
import { appLocale } from "../../i18n";
import type { NetworkTerms } from "../../holochain/types";

export type Audience = "customers" | "stores" | "drivers";

/// What a rule means for one kind of participant, over time: the upside
/// (`good`) and what it costs them when it goes against them (`bad`).
export interface Effect {
  who: Audience;
  good?: string;
  bad?: string;
}

export interface PolicySection {
  id: string;
  title: string;
  summary: string;
  points: string[];
  effects?: Effect[];
}

export interface PolicyChange {
  version: string;
  date: string;
  summary: string;
}

/// One language's policies.
export interface PolicyContent {
  changes: PolicyChange[];
  sections: (terms: NetworkTerms) => PolicySection[];
  risks: (terms: NetworkTerms) => string[];
}

/// A duration as people say it, in the app's language: "2 hours", "30
/// minutes", "1 day".
export function spoken(secs: number): string {
  const [value, unit] = secs % 86_400 === 0 ? [secs / 86_400, "day"] : secs % 3_600 === 0 ? [secs / 3_600, "hour"] : secs % 60 === 0 ? [secs / 60, "minute"] : [secs, "second"];
  return new Intl.NumberFormat(appLocale(), { style: "unit", unit: unit as string, unitDisplay: "long" }).format(value as number);
}
