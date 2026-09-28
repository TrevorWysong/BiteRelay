// Whether the connected agent is on the arbitrator roster (architecture
// plan §8.1) -- baked into DNA properties at install time, not a Profile
// role, since every validator needs to agree on the *same* roster (DNA
// properties are part of the DNA hash) rather than trusting client-local
// config. Decoded straight from AppInfo's cell_info, the same msgpack shape
// every other entry in this app decodes through (see decode.ts).
import { decode } from "@msgpack/msgpack";
import { CellType, encodeHashToBase64 } from "@holochain/client";
import { getAppWs } from "./client";
import type { AgentPubKey } from "./types";

const ROLE_NAME = "relay";

// DNA properties round-trip through `dna.yaml`'s own YAML representation,
// which has no binary literal type -- so `AgentPubKey`s in here are always
// base64 hash strings (`AgentPubKey::to_string()` on the Rust side, decoded
// back via a lenient `HoloHash` deserializer), never raw bytes, the same
// workaround `tests/tryorama/src/helpers.ts`'s `setupArbitratedPlayers`
// already documents for install-time property overrides. Confirmed by
// direct empirical test against a real conductor (see this file's own
// verification script, since assuming raw bytes here silently produced a
// roster nothing could ever match) -- not assumed from the Rust struct
// shape alone.
interface RelayDnaProperties {
  arbitrators?: string[];
}

let cachedRoster: string[] | null = null;

export async function getArbitratorRoster(): Promise<string[]> {
  if (cachedRoster) return cachedRoster;
  const info = await getAppWs().appInfo();
  const cellInfo = info.cell_info[ROLE_NAME]?.[0];
  if (!cellInfo || cellInfo.type !== CellType.Provisioned) {
    throw new Error(`no provisioned "${ROLE_NAME}" cell found`);
  }
  try {
    const properties = decode(cellInfo.value.dna_modifiers.properties) as RelayDnaProperties;
    cachedRoster = properties?.arbitrators ?? [];
  } catch {
    // No roster configured (e.g. a dev install with `properties: ~` in
    // dna.yaml) -- treat as an empty roster rather than failing connect.
    cachedRoster = [];
  }
  return cachedRoster;
}

export async function isArbitrator(agent: AgentPubKey): Promise<boolean> {
  const roster = await getArbitratorRoster();
  const agentB64 = encodeHashToBase64(agent);
  return roster.includes(agentB64);
}
