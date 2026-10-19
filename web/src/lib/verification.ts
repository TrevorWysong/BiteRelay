// Driver verification's words, shared by the driver's card and the
// verifier's screen.
import type { VerificationCheck } from "../holochain/types";
import { t } from "../i18n";

/// A check's name, in the app's language.
export const checkLabel = (check: VerificationCheck): string => t(`verification.check.${check}`);

export const ALL_CHECKS: VerificationCheck[] = ["Identity", "DrivingLicence", "Insurance", "Background"];
