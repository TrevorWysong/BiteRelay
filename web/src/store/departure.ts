// This device sending its account to a new phone (RECOVERY.md): once it
// has, its app is stopped and nothing on it may write again, so the whole
// app gives way to the code the new phone scans (`Departure`) -- across
// reloads too, which is why it's kept here.
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface DepartureState {
  /// The account's key sealed to the new phone, once sent.
  sealed: string | null;
  depart: (sealed: string) => void;
  /// Done with it: the account stayed here after all, or left this device.
  clear: () => void;
}

export const useDeparture = create<DepartureState>()(
  persist(
    (set) => ({
      sealed: null,
      depart: (sealed) => set({ sealed }),
      clear: () => set({ sealed: null }),
    }),
    { name: "relay.departure.v1" },
  ),
);
