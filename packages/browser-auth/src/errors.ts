/** Only fixed, library-owned messages cross the public error boundary. */
export class AuthFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly reason?: "action_timeout" | undefined,
  ) {
    super(message);
    this.name = "AuthFailure";
  }
}

/** Preserve a fixed diagnostic category, never the underlying exception. */
export function actionTimeout(error: unknown): "action_timeout" | undefined {
  return error instanceof AuthFailure
    ? error.reason
    : error instanceof Error && error.name === "TimeoutError"
      ? "action_timeout"
      : undefined;
}

export async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () =>
          reject(new AuthFailure("aborted", "Operation interrupted"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
