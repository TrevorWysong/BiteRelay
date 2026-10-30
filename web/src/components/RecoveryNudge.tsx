import { Link } from "react-router-dom";
import { ChevronRight, ShieldAlert } from "lucide-react";
import { bytesToHex } from "../holochain/decode";
import { myRecoveryPlan } from "../holochain/zomes/account";
import { useResource } from "../lib/hooks/useResource";
import { useSession } from "../store/session";
import { useT } from "../i18n";

/// Whether the account has a way back in -- a recovery phrase or guardians
/// -- once known. Shares the Account page's read of the plan.
function useAccountProtected(): boolean | null {
  const agentPubKey = useSession((s) => s.agentPubKey);
  const hex = agentPubKey ? bytesToHex(agentPubKey) : null;
  const { data: plan } = useResource(hex && `plan:${hex}`, myRecoveryPlan);
  // Not read yet: say nothing rather than nag someone who has one.
  if (plan === undefined) return null;
  return !!plan?.phrase_key || (plan?.guardians.length ?? 0) > 0;
}

/// Where money comes in, for an account with no way back in: there's no
/// company to reset it, so a device lost without a phrase or guardians takes
/// its balance with it (docs/RECOVERY.md). Links to setting one up.
/// `compact`, a line for inside a sheet.
export function RecoveryNudge({ compact = false }: { compact?: boolean }) {
  const t = useT();
  if (useAccountProtected() !== false) return null;
  if (compact) {
    return (
      <Link to="/account" className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
        <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        <span>
          {t("recovery.nudgeBody")} <span className="font-semibold underline">{t("recovery.nudgeAction")}</span>
        </span>
      </Link>
    );
  }
  return (
    <Link to="/account" className="mb-4 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-900/20">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-900/30">
        <ShieldAlert size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-ink-900 dark:text-ink-50">{t("recovery.nudgeTitle")}</span>
        <span className="mt-0.5 block text-xs text-ink-500">{t("recovery.nudgeBody")}</span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-ink-400" />
    </Link>
  );
}
