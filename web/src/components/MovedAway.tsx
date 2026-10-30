// What a device shows once its account has moved on to another key --
// handed over to a new device, or recovered after this one was lost. This
// key can't spend or take orders any more (the ledger closed on a
// hand-over; everyone's app refuses a recovered one), so the app stops
// here rather than letting anything fail half-way.
import { Smartphone } from "lucide-react";
import { HOST } from "../holochain/host";
import { keyFingerprint } from "../lib/account/accountMove";
import { useSession } from "../store/session";
import { Button } from "./ui";
import { useT } from "../i18n";

/// `to`: the key it moved to -- `null` when it moved to the new version of
/// HandShake (docs/MIGRATION.md).
export function MovedAway({ to }: { to: Uint8Array | null }) {
  const t = useT();
  const signOut = useSession((s) => s.signOut);
  return (
    <div className="mesh-hero flex min-h-svh flex-col items-center justify-center gap-4 px-8 text-center text-white">
      <div className="grid h-16 w-16 place-items-center rounded-3xl bg-white text-handshake-600 shadow-xl">
        <Smartphone size={28} />
      </div>
      <h1 className="text-xl font-black">{to ? t("moved.title") : t("moved.newVersionTitle")}</h1>
      {to ? (
        <>
          <p className="max-w-sm text-sm text-white/80">
            {t("moved.detail", { fingerprint: keyFingerprint(to) })}
          </p>
          <p className="max-w-sm text-xs text-white/70">{t("moved.notYou")}</p>
        </>
      ) : (
        <p className="max-w-sm text-sm text-white/80">{t("moved.newVersionDetail")}</p>
      )}
      {HOST === "dev" ? (
        <Button variant="ghost" className="bg-white text-handshake-600" onClick={signOut}>
          {t("moved.signOut")}
        </Button>
      ) : (
        <p className="text-xs text-white/70">{t("moved.remove")}</p>
      )}
    </div>
  );
}
