// Driver verification's words, shared by the driver's card and the
// verifier's screen.
import type { VerificationCheck } from "../holochain/types";

export const CHECK_LABELS: Record<VerificationCheck, string> = {
  Identity: "Identity",
  DrivingLicence: "Driving licence",
  Insurance: "Insurance",
  Background: "Background check",
};

export const ALL_CHECKS = Object.keys(CHECK_LABELS) as VerificationCheck[];
