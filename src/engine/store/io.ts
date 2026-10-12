// Shared helpers of the IndexedDB repositories: every failure leaves a repository as CtvError store.quota (quota
// exhausted) or store.io (anything else), so callers can "continue without cache".

import { CtvError, errorMessage } from "../../shared/errors.ts";

export function storeError(error: unknown, op: string): CtvError {
  if (error instanceof CtvError) return error;
  const name =
    typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string"
      ? (error as { name: string }).name
      : "";
  const message = errorMessage(error);
  return new CtvError(name === "QuotaExceededError" ? "store.quota" : "store.io", `${op}: ${message}`, {
    cause: error,
  });
}

/** Runs one repository operation and maps its failure (see storeError). */
export async function io<T>(op: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw storeError(error, op);
  }
}

/** The part of an idb cursor that bulk deletes need. */
export interface DeletableCursor {
  delete(): Promise<void>;
  continue(): Promise<DeletableCursor | null>;
}

/** Deletes every record a cursor visits; returns how many. */
export async function deleteAll(first: Promise<DeletableCursor | null>): Promise<number> {
  let deleted = 0;
  let cursor = await first;
  while (cursor !== null) {
    await cursor.delete();
    deleted += 1;
    cursor = await cursor.continue();
  }
  return deleted;
}

/** The part of an idb transaction that atomically() needs. */
export interface AbortableTransaction {
  abort(): void;
  readonly done: Promise<void>;
}

/** Runs `body` inside `tx` and waits for the commit; a throw aborts the transaction, so none of its writes land. */
export async function atomically<T>(tx: AbortableTransaction, body: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // already committed or aborted
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
  await tx.done;
  return result;
}
