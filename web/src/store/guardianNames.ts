// What a person calls their guardians -- "Mum", "Sam from work" -- kept on
// this device. A plan publishes only keys: who someone trusts with their
// account is nobody else's business, and a customer's name isn't public.
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface GuardianNames {
  /// Names by guardian key, base64.
  names: Record<string, string>;
  setName: (key: string, name: string) => void;
}

export const useGuardianNames = create<GuardianNames>()(
  persist(
    (set) => ({
      names: {},
      setName: (key, name) => set((state) => ({ names: { ...state.names, [key]: name.trim() } })),
    }),
    { name: "relay.guardian-names.v1" },
  ),
);
