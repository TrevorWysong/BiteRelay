// The app's words, in the language its person reads. English is the source
// (en.ts); a locale is added by translating it into a catalog of its own
// and listing it in LOCALES. Catalogs other than English load on demand,
// before the first render that needs them (`useLocale.choose`, and
// main.tsx at startup) -- so no screen ever waits on one.
//
// Numbers, money, dates and distances follow the same locale through
// `appLocale()` (lib/ui/format.ts). Messages from the network itself -- a
// zome's refusal -- are English: they're the network's, not the app's.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { en, type Catalog, type Message, type MessageKey } from "./en";

/// The locales the app is translated into, by BCP 47 tag, with their own
/// names for themselves.
export const LOCALES = { en: "English", es: "Español" } as const;
export type Locale = keyof typeof LOCALES;

const loaders: Record<Locale, () => Promise<Catalog>> = {
  en: async () => en,
  es: () => import("./es").then((m) => m.es),
};

/// The best of the app's locales for someone whose preferences, in order,
/// are `preferred` (a browser's `navigator.languages`): an exact match, then
/// the language alone ("es-MX" reads "es"). English when none matches.
export function negotiate(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const lower = tag.toLowerCase();
    if (lower in LOCALES) return lower as Locale;
    const language = lower.split("-")[0];
    if (language in LOCALES) return language as Locale;
  }
  return "en";
}

const deviceLocale = (): Locale => negotiate(typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]);

interface LocaleState {
  /// The person's own choice -- `null` to follow the device.
  chosen: Locale | null;
  locale: Locale;
  catalog: Catalog;
  /// Switches language: loads its catalog, then every screen re-renders in it.
  choose: (chosen: Locale | null) => Promise<void>;
}

export const useLocale = create<LocaleState>()(
  persist(
    (set) => ({
      chosen: null,
      locale: "en",
      catalog: en,
      async choose(chosen) {
        const locale = chosen ?? deviceLocale();
        const catalog = await loaders[locale]();
        set({ chosen, locale, catalog });
        document.documentElement.lang = locale;
      },
    }),
    // Only the choice is kept: the catalog loads fresh each start.
    { name: "handshake.locale", partialize: (s) => ({ chosen: s.chosen }) },
  ),
);

/// Loads the language this person reads, before the app first renders.
export async function loadLocale(): Promise<void> {
  try {
    await useLocale.getState().choose(useLocale.getState().chosen);
  } catch {
    // A catalog that wouldn't load: English, as the app ships.
  }
}

/// The app's locale, for Intl formatters.
export function appLocale(): Locale {
  return useLocale.getState().locale;
}

const pluralRules = new Map<string, Intl.PluralRules>();

/// `message` with its placeholders filled -- the plural form `vars.count`
/// takes in `locale`, when it counts something.
export function format(locale: string, message: Message, vars: Record<string, string | number> = {}): string {
  let text: string;
  if (typeof message === "string") {
    text = message;
  } else {
    let rules = pluralRules.get(locale);
    if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)));
    const category = rules.select(Number(vars.count ?? 0)) as keyof typeof message;
    text = message[category] ?? message.other;
  }
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/// A message in the current language, for code outside React.
export const t: Translate = (key, vars) => {
  const { locale, catalog } = useLocale.getState();
  return format(locale, catalog[key] ?? en[key], vars);
};

/// The translator for a component: re-renders it when the language changes.
export function useT(): Translate {
  const locale = useLocale((s) => s.locale);
  const catalog = useLocale((s) => s.catalog);
  return (key, vars) => format(locale, catalog[key] ?? en[key], vars);
}

export type { MessageKey };
