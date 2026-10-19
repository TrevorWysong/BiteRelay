// A driver's verification, as the network asks for it: who checked them
// and until when, or -- before they're verified -- the code a verifier
// scans to verify them.
import { useState } from "react";
import { BadgeCheck, ShieldQuestion } from "lucide-react";
import type { AgentPubKey } from "../../holochain/types";
import { driverVerification, getVerificationTerms } from "../../holochain/zomes/dispatch";
import { AccountCode } from "../../components/AccountCode";
import { Sheet } from "../../components/Sheet";
import { Button, Card } from "../../components/ui";
import { formatDate } from "../../lib/format";
import { POLL } from "../../lib/poll";
import { useResource } from "../../lib/useResource";
import { checkLabel } from "../../lib/verification";
import { useT } from "../../i18n";

export function VerificationCard({ me }: { me: AgentPubKey }) {
  const { data: terms } = useResource("verification-terms", getVerificationTerms);
  const { data: mine } = useResource("my-verification", () => driverVerification(me), { pollMs: POLL.slow });
  const [showing, setShowing] = useState(false);
  const t = useT();
  // Nothing to say on a network without verifiers.
  if (!terms || terms.verifiers.length === 0 || mine === undefined) return null;

  if (mine) {
    return (
      <Card className="mb-5 flex items-center gap-3 p-4">
        <BadgeCheck size={20} className="shrink-0 text-emerald-500" />
        <span className="text-sm">
          <span className="block font-semibold text-ink-900 dark:text-ink-50">{t("verification.until", { date: formatDate(mine.expires_at) })}</span>
          <span className="block text-xs text-ink-400">{mine.checks.map((c) => checkLabel(c)).join(" · ")}</span>
        </span>
      </Card>
    );
  }
  return (
    <Card className="mb-5 p-4">
      <div className="flex items-start gap-3">
        <ShieldQuestion size={20} className="mt-0.5 shrink-0 text-amber-500" />
        <span className="text-sm">
          <span className="block font-semibold text-ink-900 dark:text-ink-50">{t(terms.required ? "verification.getVerifiedRequired" : "verification.getVerified")}</span>
          <span className="block text-xs text-ink-500">
            {t("verification.how")} {terms.required ? t("verification.untilThen") : t("verification.customersSee")}
          </span>
        </span>
      </div>
      <Button className="mt-3 w-full py-2 text-xs" variant="secondary" onClick={() => setShowing(true)}>
        {t("verification.showCode")}
      </Button>
      {showing && (
        <Sheet open onClose={() => setShowing(false)} title={t("verification.yourCode")}>
          <AccountCode agent={me} note={t("verification.codeNote")} />
        </Sheet>
      )}
    </Card>
  );
}
