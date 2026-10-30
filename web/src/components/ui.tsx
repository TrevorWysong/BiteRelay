import type { HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import { ChevronDown } from "lucide-react";
import clsx from "clsx";

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx("rounded-2xl bg-white dark:bg-ink-900/60 shadow-[var(--shadow-card)] border border-ink-100/60 dark:border-ink-800", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "primary",
  className,
  children,
  loading,
  disabled,
  ...rest
}: Omit<HTMLMotionProps<"button">, "children"> & { children?: ReactNode; variant?: ButtonVariant; loading?: boolean }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-full font-semibold text-sm px-5 py-3 transition disabled:opacity-40 disabled:pointer-events-none";
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-handshake-500 text-white hover:bg-handshake-600 shadow-[var(--shadow-glow)]",
    secondary: "bg-ink dark:bg-ink-100 text-white dark:text-ink-900 hover:opacity-90",
    ghost: "bg-transparent text-ink dark:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800 border border-ink-200 dark:border-ink-700",
    danger: "bg-red-600 text-white hover:bg-red-700",
  };
  return (
    <motion.button
      className={clsx(base, variants[variant], className)}
      disabled={disabled || loading}
      whileTap={disabled || loading ? undefined : { scale: 0.96 }}
      transition={{ duration: 0.12 }}
      {...rest}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </motion.button>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "brand" | "success" | "warn" | "danger"; children: ReactNode }) {
  const tones: Record<string, string> = {
    neutral: "bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200",
    brand: "bg-handshake-100 text-handshake-700 dark:bg-handshake-900/40 dark:text-handshake-300",
    success: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    warn: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    danger: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  };
  return <span className={clsx("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold", tones[tone])}>{children}</span>;
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto pb-0.5">{children}</div>;
}

export function Chip({ active, onClick, children, tone = "default" }: { active: boolean; onClick: () => void; children: ReactNode; tone?: "default" | "danger" | "brand" }) {
  const activeClasses = tone === "danger" ? "bg-red-500 text-white" : tone === "brand" ? "bg-presence-500 text-white" : "bg-ink-900 text-white dark:bg-white dark:text-ink-900";
  return (
    <button
      onClick={onClick}
      className={clsx(
        "shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition",
        active ? activeClasses : "bg-ink-100 dark:bg-ink-800 text-ink-500 hover:bg-ink-200 dark:hover:bg-ink-700"
      )}
    >
      {children}
    </button>
  );
}

/// The one place "this is live, p2p, right now" gets a visual signature --
/// see index.css's doc comment on why presence-green is reserved rather
/// than used as a generic accent.
/// A pill-shaped tab switcher -- "Active / Past" style.
export function SegmentedTabs<T extends string>({ tabs, value, onChange }: { tabs: readonly { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <div role="tablist" className="flex rounded-full bg-ink-100 dark:bg-ink-800 p-1 text-xs font-semibold">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={clsx("rounded-full px-3 py-1 transition", value === tab.value ? "bg-white dark:bg-ink-950 shadow-sm text-ink-900 dark:text-white" : "text-ink-400")}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function PresenceDot({ live = true }: { live?: boolean }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5">
      {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-presence-400 opacity-75" />}
      <span className={clsx("relative inline-flex h-2.5 w-2.5 rounded-full", live ? "bg-presence-500" : "bg-ink-300 dark:bg-ink-600")} />
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={clsx("animate-spin h-5 w-5", className)} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function EmptyState({ icon, title, subtitle }: { icon?: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6 text-ink-400 dark:text-ink-500">
      {icon && <div className="mb-4 opacity-60">{icon}</div>}
      <p className="font-semibold text-ink-600 dark:text-ink-300">{title}</p>
      {subtitle && <p className="text-sm mt-1 max-w-xs">{subtitle}</p>}
    </div>
  );
}

/// A shimmering placeholder block matching the shape of the content that
/// will replace it (a row, a card, a line of text) -- used instead of a
/// bare centered `Spinner` for list-shaped loading states, so the layout
/// a screen is about to show is legible before any data arrives.
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("skeleton rounded-xl", className)} aria-hidden />;
}

/// Consistent "this number matters" treatment -- order totals, balances,
/// earnings, the transparency dashboard's stats. Tabular figures so
/// digits don't jitter the layout as they change, tight tracking for a
/// confident, editorial feel, one shared place to tune rather than each
/// screen hand-rolling its own `font-black` + color combination.
export function StatNumber({ children, className, tone = "default" }: { children: ReactNode; className?: string; tone?: "default" | "brand" | "success" | "danger" }) {
  const tones: Record<string, string> = {
    default: "text-ink-900 dark:text-ink-50",
    brand: "text-handshake-600 dark:text-handshake-400",
    success: "text-presence-600 dark:text-presence-400",
    danger: "text-red-600 dark:text-red-400",
  };
  return <span className={clsx("font-black tracking-tight tabular-nums", tones[tone], className)}>{children}</span>;
}

/// Shared "filled field" look for every text input, textarea, and select
/// in the app -- a soft tinted background that lifts to a crisper
/// white/dark surface plus a brand-colored ring on focus, instead of a
/// bare bordered box that just changes border color. One place to tune so
/// every form field in the app reads as the same, deliberately designed
/// control rather than each screen's raw browser default.
const fieldBase =
  "w-full rounded-xl border border-ink-200/70 dark:border-ink-700/70 bg-ink-50/80 dark:bg-ink-800/50 px-3.5 py-2.5 text-sm text-ink-900 dark:text-ink-50 placeholder:text-ink-400 dark:placeholder:text-ink-500 outline-none transition focus:border-handshake-400 focus:bg-white dark:focus:bg-ink-900 focus:ring-2 focus:ring-handshake-100 dark:focus:ring-handshake-900/40";

type Adornment = { prefix?: ReactNode; suffix?: ReactNode };

/// `prefix`/`suffix` render as fixed, non-editable glyphs inside the field
/// (e.g. `prefix={currencySymbol()}` for an amount, `suffix="%"` for a percentage)
/// -- unlike placeholder text, these never disappear once the customer
/// starts typing, so the unit stays legible the whole time.
export function Input({ className, prefix, suffix, ...rest }: InputHTMLAttributes<HTMLInputElement> & Adornment) {
  if (!prefix && !suffix) return <input className={clsx(fieldBase, className)} {...rest} />;
  return (
    <div className="relative flex items-center">
      {prefix && <span className="pointer-events-none absolute left-3.5 text-sm font-medium text-ink-400">{prefix}</span>}
      <input className={clsx(fieldBase, prefix && "pl-7", suffix && "pr-8", className)} {...rest} />
      {suffix && <span className="pointer-events-none absolute right-3.5 text-sm font-medium text-ink-400">{suffix}</span>}
    </div>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(fieldBase, "resize-none", className)} {...rest} />;
}

/// Native `<select>`s render their own platform-default arrow and chrome
/// that doesn't match anything else in this app -- `appearance-none` turns
/// that off, and a `ChevronDown` icon stands in for it, styled the same as
/// every other field.
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={clsx(fieldBase, "appearance-none pr-9", className)} {...rest}>
        {children}
      </select>
      <ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
    </div>
  );
}

export function Checkbox({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={clsx(
        "h-4 w-4 shrink-0 rounded-md border-ink-300 dark:border-ink-600 text-handshake-500 accent-handshake-500 focus:ring-2 focus:ring-handshake-100 dark:focus:ring-handshake-900/40",
        className
      )}
      {...rest}
    />
  );
}

/// A persistent label above a field, rather than relying on placeholder
/// text -- placeholder text disappears the instant something's typed,
/// which reads as "this field has no label at all" once filled in.
/// Shared by every form in the app (onboarding, merchant storefront
/// details, goodie-bag creation, ...) specifically so every field looks
/// and behaves the same way regardless of which screen it's on, rather
/// than each screen inventing its own near-identical label markup.
/// An on/off setting -- a labelled switch, announced as one.
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-40", checked ? "bg-handshake-500" : "bg-ink-200 dark:bg-ink-700")}
    >
      <span className={clsx("inline-block h-5 w-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-5" : "translate-x-0.5")} />
    </button>
  );
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="mb-1 block text-xs font-semibold text-ink-500">{label}</label>
      {children}
    </div>
  );
}
