import { NavLink } from "react-router-dom";
import clsx from "clsx";
import type { Home } from "lucide-react";

/// One tab of the bottom navigation, with an optional count badge.
export function BottomNavLink({ to, icon: Icon, label, badge }: { to: string; icon: typeof Home; label: string; badge?: number }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        clsx(
          "relative flex flex-1 flex-col items-center justify-center gap-1 py-2 text-xs font-medium transition",
          isActive ? "text-relay-600 dark:text-relay-400" : "text-ink-400 dark:text-ink-500"
        )
      }
    >
      <div className="relative">
        <Icon size={22} strokeWidth={2.25} />
        {!!badge && (
          <span className="absolute -top-1.5 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-relay-500 px-1 text-[10px] font-bold text-white">
            {badge}
          </span>
        )}
      </div>
      {label}
    </NavLink>
  );
}
