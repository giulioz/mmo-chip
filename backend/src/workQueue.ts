import { HttpError } from "./security.js";

/** Bounded FIFO admission shared by every caller, including background jobs. */
export function createWorkQueue(concurrency: number, maxPending: number) {
  let active = 0;
  const pending: (() => void)[] = [];
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      if (pending.length >= maxPending) throw new HttpError(429, "Processing queue is full; retry later");
      await new Promise<void>(resolve => pending.push(resolve));
    } else active++;
    try { return await work(); }
    finally {
      const next = pending.shift();
      if (next) next(); else active--;
    }
  };
}
export const imageWork = createWorkQueue(2, 32);
export const mlWork = createWorkQueue(1, 16);
export const importWork = createWorkQueue(1, 4);
