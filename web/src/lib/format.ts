export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatEta(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

export function timeAgo(microseconds: number): string {
  const ms = microseconds / 1000;
  const deltaS = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (deltaS < 60) return "just now";
  if (deltaS < 3600) return `${Math.round(deltaS / 60)}m ago`;
  if (deltaS < 86400) return `${Math.round(deltaS / 3600)}h ago`;
  return `${Math.round(deltaS / 86400)}d ago`;
}

export function shortAgentId(agent: Uint8Array): string {
  const hex = Array.from(agent.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}
