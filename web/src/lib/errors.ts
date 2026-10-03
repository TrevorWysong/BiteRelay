// Holochain zome-call failures surface as raw Wasm/Ribosome runtime traces,
// e.g. `Wasm runtime error while working with Ribosome: RuntimeError:
// dispatch::orders:412: Guest("cannot complete delivery: 0 of 2 required leg
// attestations found")`. The only part meant for a human is the text inside
// Guest(...). This pulls that out so UI error banners read like a sentence,
// not a stack trace.
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(/Guest\("((?:[^"\\]|\\.)*)"\)/);
  if (match) {
    return match[1].replace(/\\"/g, '"').replace(/\\n/g, " ");
  }
  return raw;
}
