// The app's language: the device's, or one the person picks.
import { Languages } from "lucide-react";
import { LOCALES, negotiate, useLocale, useT, type Locale } from "../i18n";
import { Card, Select } from "./ui";

export function LanguagePicker() {
  const t = useT();
  const chosen = useLocale((s) => s.chosen);
  const choose = useLocale((s) => s.choose);
  const device = LOCALES[negotiate(navigator.languages ?? [navigator.language])];
  return (
    <Card className="mb-4 flex items-center gap-3 p-4">
      <Languages size={18} className="shrink-0 text-ink-400" />
      <span className="flex-1 text-sm font-semibold text-ink-900 dark:text-ink-50">{t("language.title")}</span>
      <Select className="w-auto" value={chosen ?? ""} onChange={(e) => void choose((e.target.value || null) as Locale | null)}>
        <option value="">{t("language.device", { language: device })}</option>
        {(Object.keys(LOCALES) as Locale[]).map((locale) => (
          <option key={locale} value={locale}>
            {LOCALES[locale]}
          </option>
        ))}
      </Select>
    </Card>
  );
}
