// Moving this account to a new phone with its key (docs/RECOVERY.md) needs the
// device's keystore and its conductor's admin side, which the UI never
// touches. The runtime hosting the app does that work (runtime/device, the
// `relay_device` crate) and hands the UI six commands, as
// `window.__RELAY_DEVICE__` -- one object whatever the runtime, each command
// taking and returning strings:
//
//   canMove()        whether this device's account can move by its key
//   invite()         the new phone: an invitation code to show
//   send(invitation) the old phone: stops the app for good, returns the
//                    account's key sealed to the invitation
//   stay()           the old phone: takes the account back -- only while the
//                    new phone hasn't used the key
//   retire()         the old phone: removes the account from this device
//   receive(sealed)  the new phone: takes the key in and restores the
//                    account from the network; resolves once it's running
//                    here, after which the app reloads
//
// A runtime without them (one that can't move keys) leaves it undefined:
// the app then offers recovery instead. In development the dev host stands
// in for the runtime (`devDevice.ts`).
import { callZome } from "./client";
import { HOST } from "./host";

export interface DeviceRuntime {
  /// Both phones are one node (the dev host). There the network never
  /// reports a chain only that node holds, so the old phone doesn't wait for
  /// it -- nothing has to cross to another node.
  oneNode?: boolean;
  canMove(): Promise<boolean>;
  invite(): Promise<string>;
  send(invitation: string): Promise<string>;
  stay(): Promise<void>;
  retire(): Promise<void>;
  receive(sealed: string): Promise<void>;
}

declare global {
  interface Window {
    __RELAY_DEVICE__?: DeviceRuntime;
  }
}

/// The runtime's commands, where there are any.
export async function deviceRuntime(): Promise<DeviceRuntime | null> {
  if (HOST === "launcher") return window.__RELAY_DEVICE__ ?? null;
  if (__DEV_HOST__ && HOST === "dev") return (await import("./devDevice")).devDevice;
  return null;
}

/// Whether this device can move its account to a new phone by its key.
export async function canMoveAccount(): Promise<boolean> {
  const runtime = await deviceRuntime();
  return !!runtime && (await runtime.canMove().catch(() => false));
}

/// Whether a new phone can take an account in by its key.
export async function canReceiveAccount(): Promise<boolean> {
  return (await deviceRuntime()) !== null;
}

/// Sets this device up to take part, where it isn't: the grants that let
/// signals and handoff codes reach it, and its background work. A device
/// set up at signup already is; one that received its account by restore
/// isn't, so the app does this on every start. Each zome on its own, so
/// one's trouble doesn't stop the others.
export async function prepareDevice(): Promise<void> {
  await Promise.allSettled(["dispatch", "catalog", "attestation"].map((zome) => callZome(zome, "prepare_device", null)));
}
