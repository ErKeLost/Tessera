export type AbortResilientAsyncCache<T> = Readonly<{
  get(signal?: AbortSignal): Promise<T>;
}>;

/**
 * Coalesces a load without allowing one HTTP request cancellation to poison
 * the shared value. Failed loads are deliberately retried by the next caller.
 */
export function createAbortResilientAsyncCache<T>(
  load: () => Promise<T>,
): AbortResilientAsyncCache<T> {
  let hasValue = false;
  let value: T;
  let inFlight: Promise<T> | undefined;

  const startLoad = (): Promise<T> => {
    const task = Promise.resolve().then(load);
    inFlight = task;
    void task.then(
      (loaded) => {
        value = loaded;
        hasValue = true;
        if (inFlight === task) inFlight = undefined;
      },
      () => {
        if (inFlight === task) inFlight = undefined;
      },
    );
    return task;
  };

  return Object.freeze({
    get(signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      const task = hasValue
        ? Promise.resolve(value)
        : (inFlight ?? startLoad());
      return waitForAbort(task, signal);
    },
  });
}

function waitForAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void task.then(
      (loaded) => {
        cleanup();
        resolve(loaded);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortError(): DOMException {
  return new DOMException("The database operation was cancelled.", "AbortError");
}
