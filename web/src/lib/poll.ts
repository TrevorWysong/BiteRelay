// How often screens re-read the conductor. Signals carry nearly every
// change to the agents it concerns (an order's parties hear of every update
// -- see `dispatch::signals::post_commit`), so for most screens a poll is
// only the backstop for a dropped signal. Polls pause while the tab is
// hidden (see `usePolling`).
export const POLL = {
  /// A screen whose changes reach it as signals: polling only covers a
  /// signal that went missing.
  signalled: 30_000,
  /// A screen showing what changes without telling this agent -- another
  /// driver taking a nearby order, a new dispute case.
  unsignalled: 15_000,
  /// An online driver's view of open orders nearby. Nothing pushes new
  /// orders to drivers (they'd have to announce where they are), so this is
  /// how fast a driver hears of one.
  driverFeed: 5_000,
  /// Slow-moving reads: stores nearby, a menu.
  slow: 60_000,
  /// A card payment that's gone through, until its funds land: the issuer
  /// grants them within seconds of hearing from the processor.
  payment: 2_000,
} as const;

/// Whether a signal says an order changed -- what every order screen
/// refreshes on.
export const isOrderSignal = (signal: object) => "OrderUpdated" in signal || "OrderChanged" in signal || "OrderPlaced" in signal;
