// A backstop independent of whatever cancellation mechanism the wrapped
// operation claims to support. `webauthn.ts`'s own AbortSignal.timeout()
// is spec-required to work, but that assumes the browser's WebAuthn
// implementation actually honors `signal` -- confirmed directly that at
// least one real browser (Safari) can leave a navigator.credentials.get()
// ceremony hanging well past its own signal's deadline, with no rejection
// ever arriving. A plain setTimeout racing the promise doesn't depend on
// the callee cooperating at all, so it bounds the wait regardless.
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
