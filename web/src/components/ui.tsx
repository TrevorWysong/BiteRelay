import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
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
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-full font-semibold text-sm px-5 py-3 transition active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none";
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-relay-500 text-white hover:bg-relay-600 shadow-[0_6px_16px_-4px_rgba(255,90,43,0.55)]",
    secondary: "bg-ink dark:bg-ink-100 text-white dark:text-ink-900 hover:opacity-90",
    ghost: "bg-transparent text-ink dark:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800 border border-ink-200 dark:border-ink-700",
    danger: "bg-red-600 text-white hover:bg-red-700",
  };
  return (
    <button className={clsx(base, variants[variant], className)} disabled={disabled || loading} {...rest}>
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "brand" | "success" | "warn" | "danger"; children: ReactNode }) {
  const tones: Record<string, string> = {
    neutral: "bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200",
    brand: "bg-relay-100 text-relay-700 dark:bg-relay-900/40 dark:text-relay-300",
    success: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    warn: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    danger: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  };
  return <span className={clsx("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold", tones[tone])}>{children}</span>;
}

/// The one place "this is live, p2p, right now" gets a visual signature --
/// see index.css's doc comment on why presence-green is reserved rather
/// than used as a generic accent.
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
