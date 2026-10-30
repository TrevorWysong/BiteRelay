// This device has sent its account to a new phone (docs/RECOVERY.md): its app
// has stopped, so this is all it shows -- the sealed code for the new phone
// to scan, until the person says the new phone has the account (and this
// device lets it go), or takes it back because the new phone never
// finished.
import { useState } from "react";
import { Smartphone } from "lucide-react";
import { deviceRuntime } from "../holochain/device";
import { HOST } from "../holochain/host";
import { useDeparture } from "../store/departure";
import { describeError } from "../lib/ui/errors";
import { sealedAccount } from "../lib/account/deviceMove";
import { keyFingerprint } from "../lib/account/accountMove";
import { CodeCard } from "./AccountCode";
import { Button } from "./ui";
import { useT } from "../i18n";

type Step = "show" | "done" | "stay" | "removed";

export function Departure({ sealed }: { sealed: string }) {
  const t = useT();
  const clear = useDeparture((s) => s.clear);
  const [step, setStep] = useState<Step>("show");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = sealedAccount(sealed);

  async function act(command: "retire" | "stay") {
    setBusy(true);
    setError(null);
    try {
      const runtime = await deviceRuntime();
      if (!runtime) throw new Error(t("move.unsupported"));
      await runtime[command]();
      clear();
      // Taken back: the app starts again as it was. Let go: in development
      // this browser forgets the identity and signs in afresh; in a runtime
      // there's nothing left here to open.
      if (command === "stay" || HOST === "dev") window.location.reload();
      else setStep("removed");
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <div className="mesh-hero flex min-h-svh flex-col items-center justify-center gap-4 px-6 py-10 text-center text-white">
      <div className="grid h-14 w-14 place-items-center rounded-3xl bg-white text-handshake-600 shadow-xl">
        <Smartphone size={26} />
      </div>
      {step === "removed" ? (
        <>
          <h1 className="text-xl font-black">{t("departure.removedTitle")}</h1>
          <p className="max-w-sm text-sm text-white/80">{t("departure.removed")}</p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-black">{t("departure.title")}</h1>
          <p className="max-w-sm text-sm text-white/80">{t("departure.detail")}</p>
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 text-ink-900 shadow-xl dark:bg-ink-900 dark:text-ink-50">
            {step === "show" && <CodeCard code={sealed} fingerprint={account ? keyFingerprint(account) : ""} note={t("departure.note")} />}
            {step === "done" && <p className="text-sm">{t("departure.doneConfirm")}</p>}
            {step === "stay" && <p className="text-sm text-amber-700 dark:text-amber-400">{t("departure.stayWarning")}</p>}
            {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
          </div>
          {step === "show" ? (
            <div className="flex w-full max-w-sm flex-col gap-2">
              <Button className="w-full bg-white text-handshake-600" variant="ghost" onClick={() => setStep("done")}>
                {t("departure.done")}
              </Button>
              <button type="button" onClick={() => setStep("stay")} className="text-xs text-white/70 underline underline-offset-2">
                {t("departure.stay")}
              </button>
            </div>
          ) : (
            <div className="flex w-full max-w-sm flex-col gap-2">
              <Button className="w-full bg-white text-handshake-600" variant="ghost" loading={busy} onClick={() => act(step === "done" ? "retire" : "stay")}>
                {step === "done" ? t("departure.remove") : t("departure.stayConfirm")}
              </Button>
              <button type="button" disabled={busy} onClick={() => setStep("show")} className="text-xs text-white/70 underline underline-offset-2">
                {t("common.back")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
