/// The persistent dev conductor's admin address -- fixed by
/// web/scripts/dev-conductor.mjs (port 8870 unless HANDSHAKE_ADMIN_PORT is set
/// there; mirror it here with VITE_HANDSHAKE_ADMIN_URL).
export const DEV_ADMIN_URL: string = import.meta.env.VITE_HANDSHAKE_ADMIN_URL ?? "ws://localhost:8870";

/// "seed-mo-haddad" -> "Mo Haddad" (see web/scripts/seed.mjs); any other
/// identity gets a short, stable label from its agent key.
export function identityLabel(installedAppId: string, agentKeyB64: string): string {
  if (installedAppId.startsWith("seed-")) {
    return installedAppId
      .slice("seed-".length)
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  return `Identity ${agentKeyB64.slice(5, 11)}`;
}
