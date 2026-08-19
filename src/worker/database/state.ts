// ============================================================================
// Per-instance delta state.
// ----------------------------------------------------------------------------
// Every engine reports its workload as monotonic counters, so a rate needs the
// previous reading. Holding that here rather than inside each adapter keeps the
// lifecycle in one place: the scheduler clears an instance's state when it is
// deleted or reconfigured, and a stale reading can never survive a URI change.
//
// Per-process and bounded by tenant churn, exactly like the polling pools it
// sits alongside.
// ============================================================================

interface Entry<T = any> {
  /** Wall clock of the reading, in epoch ms. */
  at: number;
  counters: T;
  /** Epoch ms of the last collection/table census, to pace it hourly. */
  lastCensusAt: number;
}

const store = new Map<string, Entry>();

export const getPrevious = <T = any>(dbId: string): Entry<T> | undefined => store.get(dbId);

export const setPrevious = <T>(dbId: string, counters: T, lastCensusAt: number): void => {
  store.set(dbId, { at: Date.now(), counters, lastCensusAt });
};

/** Records that a census just ran, without disturbing the counter reading. */
export const markCensus = (dbId: string, at: number): void => {
  const entry = store.get(dbId);
  if (entry) entry.lastCensusAt = at;
};

export const clearPrevious = (dbId: string): void => {
  store.delete(dbId);
};

/**
 * Instances this process currently holds state for. The cleanup pass walks this
 * rather than the adapters' private pools, so an instance whose delta state
 * outlived its client is still reclaimed.
 */
export const trackedIds = (): string[] => [...store.keys()];

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Whether the hourly collection/table census is due for this instance. */
export const censusDue = (dbId: string): boolean => {
  const entry = store.get(dbId);
  return !entry || Date.now() - entry.lastCensusAt > ONE_HOUR_MS;
};

/** Seconds between the previous reading and now; 0 when there is no baseline. */
export const elapsedSeconds = (previous: Entry | undefined, now: number): number =>
  previous ? Math.max(0, (now - previous.at) / 1000) : 0;

// ---------------------------------------------------------------------------
// Query-insight baselines.
//
// Digest tables are cumulative per shape, so a window's cost is the difference
// between two readings. Kept apart from the metric counters above because the
// cadences differ and because a shape that disappears from the engine's table
// (evicted, or reset) must not leave a phantom baseline behind — the map is
// replaced wholesale each cycle rather than merged.
// ---------------------------------------------------------------------------

export interface DigestCounters {
  executions: number;
  totalTimeMs: number;
  rowsReturned?: number;
  rowsExamined?: number;
  blocksHit?: number;
  blocksRead?: number;
  tempBlocks?: number;
}

interface InsightEntry {
  at: number;
  digests: Map<string, DigestCounters>;
}

const insightStore = new Map<string, InsightEntry>();

export const getInsightBaseline = (dbId: string): InsightEntry | undefined =>
  insightStore.get(dbId);

export const setInsightBaseline = (dbId: string, digests: Map<string, DigestCounters>): void => {
  insightStore.set(dbId, { at: Date.now(), digests });
};

export const clearInsightBaseline = (dbId: string): void => {
  insightStore.delete(dbId);
};
