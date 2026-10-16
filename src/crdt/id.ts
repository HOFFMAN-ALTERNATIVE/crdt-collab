/**
 * Lamport-timestamped identifiers. Every character, every map write and every
 * operation is identified by `(clock, client)`; ties on the clock are broken by
 * the client id, giving a strict total order that all replicas agree on.
 */
export interface Id {
  readonly client: string;
  readonly clock: number;
}

export const idKey = (id: Id): string => `${id.clock}@${id.client}`;

export function compareIds(a: Id, b: Id): number {
  if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1;
  if (a.client === b.client) return 0;
  return a.client < b.client ? -1 : 1;
}

export const sameId = (a: Id | null, b: Id | null): boolean =>
  a === b || (a !== null && b !== null && a.clock === b.clock && a.client === b.client);
