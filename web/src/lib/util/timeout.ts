// Bounds a wait without relying on the callee to honor cancellation. Safari
// can leave a `navigator.credentials.get()` ceremony hanging past its abort
// signal's deadline with no rejection; a timer racing the promise doesn't
// need the callee's cooperation.
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
