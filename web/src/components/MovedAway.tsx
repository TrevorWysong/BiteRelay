// What a device shows once its account has moved on to another key --
// handed over to a new device, or recovered after this one was lost. This
// key can't spend or take orders any more (the ledger closed on a
// hand-over; everyone's app refuses a recovered one), so the app stops
// here rather than letting anything fail half-way.
import { Smartphone } from "lucide-react";
import { HOST } from "../holochain/host";
import { keyFingerprint } from "../lib/accountMove";
import { useSession } from "../store/session";
import { Button } from "./ui";

/// `to`: the key it moved to -- `null` when it moved to the new version of
/// Relay (MIGRATION.md).
export function MovedAway({ to }: { to: Uint8Array | null }) {
  const signOut = useSession((s) => s.signOut);
  return (
    <div className="mesh-hero flex min-h-svh flex-col items-center justify-center gap-4 px-8 text-center text-white">
      <div className="grid h-16 w-16 place-items-center rounded-3xl bg-white text-relay-600 shadow-xl">
        <Smartphone size={28} />
      </div>
      <h1 className="text-xl font-black">{to ? "Your account has moved" : "You're on the new version of Relay"}</h1>
      {to ? (
        <>
          <p className="max-w-sm text-sm text-white/80">
            It's on another device now ({keyFingerprint(to)}), with your balance and history. This device can't use it any more.
          </p>
          <p className="max-w-sm text-xs text-white/70">If you didn't move it, someone used your recovery phrase or your guardians. Recover it again from your recovery phrase, and speak to your guardians.</p>
        </>
      ) : (
        <p className="max-w-sm text-sm text-white/80">Your account, balance and history moved to the new version. Open it there: this version can't use your account any more.</p>
      )}
      {HOST === "dev" ? (
        <Button variant="ghost" className="bg-white text-relay-600" onClick={signOut}>
          Sign out of this device
        </Button>
      ) : (
        <p className="text-xs text-white/70">You can remove Relay from this device.</p>
      )}
    </div>
  );
}
