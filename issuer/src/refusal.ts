// A message the app shows the person it's for: one of the issuer's
// refusals. Every call is read by web/scripts/refusals.ts, which puts the
// text in the app's catalogs to be translated -- so it's a whole sentence,
// with any values in `${...}`, never a fragment joined to another.
export function refusal(text: string): string {
  return text;
}
