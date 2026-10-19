// The policies page's content: how money, deliveries, problems and
// disputes work on Relay, and what each can mean for you over time -- in
// the app's language (policies/en.ts is the source).
//
// Keep it true. Every statement describes a rule the network's validation
// or the app enforces (see SECURITY.md); numbers that a network can set are
// filled in from its own settings (`NetworkTerms`), never typed. When a
// rule changes, change every language's text, bump `POLICY_VERSION`, and
// add a line to each one's changes.
import type { NetworkTerms } from "../holochain/types";
import { appLocale, type Locale } from "../i18n";
import type { PolicyChange, PolicyContent, PolicySection } from "./policies/common";
import { en } from "./policies/en";
import { es } from "./policies/es";

export { spoken, type Audience, type Effect, type PolicySection } from "./policies/common";

export const POLICY_VERSION = "1.3";
export const POLICY_UPDATED = "2026-10-19";

export const POLICIES: Record<Locale, PolicyContent> = { en, es };

const content = (): PolicyContent => POLICIES[appLocale()] ?? en;

export const policyChanges = (): PolicyChange[] => content().changes;
export const policySections = (terms: NetworkTerms): PolicySection[] => content().sections(terms);
export const policyRisks = (terms: NetworkTerms): string[] => content().risks(terms);
