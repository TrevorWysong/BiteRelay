// How Relay works: the rules for payments, deliveries, missing items,
// cancellations, disputes, reputation and privacy, what each means for
// customers, stores and drivers over time, and the risks. Content lives in
// `lib/policies.ts`; this network's numbers come from its own settings.
import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowUpRight, Bike, ChevronDown, Info, ShoppingBag, Store, TriangleAlert } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { NetworkTerms } from "../holochain/types";
import { POLICY_UPDATED, POLICY_VERSION, policyChanges, policyRisks, policySections, spoken, type Audience, type PolicySection } from "../lib/policies";
import { appLocale, useT, type MessageKey } from "../i18n";
import { formatCents } from "../lib/format";
import { fadeSlideUp, staggerContainer } from "../lib/motion";
import { useTerms } from "../store/network";

const AUDIENCE: Record<Audience, { label: MessageKey; Icon: typeof Bike }> = {
  customers: { label: "policies.audience.customers", Icon: ShoppingBag },
  stores: { label: "policies.audience.stores", Icon: Store },
  drivers: { label: "policies.audience.drivers", Icon: Bike },
};

export function Policies() {
  const navigate = useNavigate();
  const terms = useTerms();
  const t = useT();
  const updated = new Date(`${POLICY_UPDATED}T12:00:00`).toLocaleDateString(appLocale(), { dateStyle: "long" });

  return (
    <motion.article variants={staggerContainer} initial="hidden" animate="visible" className="px-5 pb-16 pt-4">
      <button onClick={() => navigate(-1)} className="-ml-1 mb-6 flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800 dark:hover:text-ink-200">
        <ArrowLeft size={16} /> {t("common.back")}
      </button>

      <motion.header variants={fadeSlideUp} className="mb-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-400">{t("policies.eyebrow")}</p>
        <h1 className="mt-2 text-[28px] font-black leading-tight tracking-tight text-ink-900 dark:text-ink-50">{t("policies.title")}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-600 dark:text-ink-300">
          {t("policies.intro")}
        </p>
        <p className="mt-4 text-xs text-ink-400">
          {t("policies.version", { version: POLICY_VERSION, date: updated })}
        </p>
      </motion.header>

      <PolicyBody terms={terms} />
    </motion.article>
  );
}

function PolicyBody({ terms }: { terms: NetworkTerms }) {
  const t = useT();
  const sections = policySections(terms);
  return (
    <>
      <motion.nav variants={fadeSlideUp} aria-label={t("policies.contents")} className="mb-10 border-y border-ink-100 py-4 dark:border-ink-800">
        <ol className="grid grid-cols-1 gap-y-2 text-sm sm:grid-cols-2">
          {[...sections, { id: "terms", title: t("policies.terms.title") }, { id: "risks", title: t("policies.risks.title") }, { id: "changes", title: t("policies.changes.title") }].map((s, i) => (
            <li key={s.id}>
              {/* Scrolls in place: the app's router owns the URL's hash. */}
              <button
                onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="group flex items-baseline gap-3 text-left text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-ink-50"
              >
                <span className="w-4 text-right text-xs tabular-nums text-ink-300 dark:text-ink-600">{i + 1}</span>
                <span className="underline-offset-4 group-hover:underline">{s.title}</span>
              </button>
            </li>
          ))}
        </ol>
      </motion.nav>

      <div className="flex flex-col gap-12">
        {sections.map((section, i) => (
          <Section key={section.id} index={i + 1} section={section} />
        ))}
        <Terms index={sections.length + 1} terms={terms} />
        <Risks index={sections.length + 2} terms={terms} />
        <Changes index={sections.length + 3} />
      </div>

      <motion.footer variants={fadeSlideUp} className="mt-14 border-t border-ink-100 pt-6 text-xs leading-relaxed text-ink-400 dark:border-ink-800">
        {t("policies.ledger")}{" "}
        <Link to="/transparency" className="inline-flex items-center gap-0.5 font-medium text-ink-600 underline-offset-4 hover:underline dark:text-ink-300">
          {t("policies.seeLedger")} <ArrowUpRight size={12} />
        </Link>
      </motion.footer>
    </>
  );
}

function Heading({ index, id, title, summary }: { index: number; id: string; title: string; summary?: string }) {
  return (
    <header className="mb-4 scroll-mt-6" id={id}>
      <p className="text-xs font-semibold tabular-nums text-ink-300 dark:text-ink-600">{String(index).padStart(2, "0")}</p>
      <h2 className="mt-1 text-lg font-bold tracking-tight text-ink-900 dark:text-ink-50">{title}</h2>
      {summary && <p className="mt-2 text-[15px] leading-relaxed text-ink-700 dark:text-ink-200">{summary}</p>}
    </header>
  );
}

function Section({ index, section }: { index: number; section: PolicySection }) {
  return (
    <motion.section variants={fadeSlideUp}>
      <Heading index={index} id={section.id} title={section.title} summary={section.summary} />
      <ul className="flex flex-col gap-2.5">
        {section.points.map((point) => (
          <li key={point} className="flex gap-3 text-sm leading-relaxed text-ink-600 dark:text-ink-300">
            <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-ink-300 dark:bg-ink-600" />
            {point}
          </li>
        ))}
      </ul>
      {section.effects && <Effects effects={section.effects} />}
    </motion.section>
  );
}

/// What a rule means for each kind of participant -- folded away, so the
/// page reads as one document and the detail is there when wanted.
function Effects({ effects }: { effects: NonNullable<PolicySection["effects"]> }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <div className="mt-5 rounded-2xl border border-ink-100 dark:border-ink-800">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-ink-700 dark:text-ink-200">
        {t("policies.overTime")}
        <ChevronDown size={16} className={`text-ink-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <dl className="divide-y divide-ink-100 border-t border-ink-100 dark:divide-ink-800 dark:border-ink-800">
          {effects.map(({ who, good, bad }) => {
            const { label, Icon } = AUDIENCE[who];
            return (
              <div key={who} className="px-4 py-3.5">
                <dt className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
                  <Icon size={13} /> {t(label)}
                </dt>
                {good && (
                  <dd className="flex gap-2.5 text-sm leading-relaxed text-ink-600 dark:text-ink-300">
                    <span className="mt-0.5 shrink-0 text-xs font-bold text-green-600 dark:text-green-400">+</span>
                    {good}
                  </dd>
                )}
                {bad && (
                  <dd className="mt-1.5 flex gap-2.5 text-sm leading-relaxed text-ink-600 dark:text-ink-300">
                    <span className="mt-0.5 shrink-0 text-xs font-bold text-amber-600 dark:text-amber-400">−</span>
                    {bad}
                  </dd>
                )}
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}

/// This network's own settings, as its DNA sets them.
function Terms({ index, terms }: { index: number; terms: NetworkTerms }) {
  const t = useT();
  const rows: [string, string][] = [
    [t("policies.terms.respond"), spoken(terms.store_response_secs)],
    [t("policies.terms.report"), spoken(terms.report_window_secs)],
    [t("policies.terms.claim"), spoken(terms.claim_grace_secs)],
    [t("policies.terms.carry"), String(terms.max_concurrent_deliveries)],
    [t("policies.terms.credit"), terms.credit_limit_cents ? formatCents(terms.credit_limit_cents) : t("policies.terms.nothing")],
    [t("policies.terms.fee"), t("policies.terms.none")],
    ...(terms.appeals ? ([[t("policies.terms.appeal"), spoken(terms.appeal_window_secs)]] as [string, string][]) : []),
    [t("policies.terms.verified"), terms.drivers_verified ? t("policies.terms.yes") : t("policies.terms.no")],
    [t("policies.terms.age"), terms.restricted_min_age ? String(terms.restricted_min_age) : t("policies.terms.notSold")],
  ];
  return (
    <motion.section variants={fadeSlideUp}>
      <Heading index={index} id="terms" title={t("policies.terms.title")} summary={t("policies.terms.summary")} />
      <dl className="overflow-hidden rounded-2xl border border-ink-100 dark:border-ink-800">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 border-b border-ink-100 px-4 py-3 text-sm last:border-0 dark:border-ink-800">
            <dt className="text-ink-500 dark:text-ink-400">{label}</dt>
            <dd className="shrink-0 font-semibold tabular-nums text-ink-900 dark:text-ink-50">{value}</dd>
          </div>
        ))}
      </dl>
    </motion.section>
  );
}

function Risks({ index, terms }: { index: number; terms: NetworkTerms }) {
  const t = useT();
  return (
    <motion.section variants={fadeSlideUp}>
      <Heading index={index} id="risks" title={t("policies.risks.title")} />
      <div className="rounded-2xl bg-ink-100/70 p-5 dark:bg-ink-900">
        <p className="mb-4 flex items-start gap-2 text-sm font-medium leading-relaxed text-ink-800 dark:text-ink-100">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          {t("policies.risks.intro")}
        </p>
        <ol className="flex flex-col gap-3">
          {policyRisks(terms).map((risk, i) => (
            <li key={risk} className="flex gap-3 text-sm leading-relaxed text-ink-600 dark:text-ink-300">
              <span className="w-4 shrink-0 text-right text-xs tabular-nums leading-relaxed text-ink-400">{i + 1}.</span>
              {risk}
            </li>
          ))}
        </ol>
      </div>
    </motion.section>
  );
}

function Changes({ index }: { index: number }) {
  const t = useT();
  return (
    <motion.section variants={fadeSlideUp}>
      <Heading
        index={index}
        id="changes"
        title={t("policies.changes.title")}
        summary={t("policies.changes.summary")}
      />
      <ol className="relative ml-1.5 border-l border-ink-200 dark:border-ink-800">
        {policyChanges().map((change) => (
          <li key={change.version} className="mb-1 pl-5">
            <span className="absolute -left-[4.5px] mt-1.5 h-2 w-2 rounded-full bg-ink-300 dark:bg-ink-600" />
            <p className="text-sm font-semibold text-ink-800 dark:text-ink-100">
              {t("policies.changes.version", { version: change.version })} <span className="font-normal text-ink-400">· {new Date(`${change.date}T12:00:00`).toLocaleDateString(appLocale(), { dateStyle: "medium" })}</span>
            </p>
            <p className="mt-1 text-sm leading-relaxed text-ink-600 dark:text-ink-300">{change.summary}</p>
          </li>
        ))}
      </ol>
      <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-ink-400">
        <Info size={13} className="mt-0.5 shrink-0" />
        {t("policies.codeRuns")}
      </p>
    </motion.section>
  );
}
