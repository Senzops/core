import type { IDbMetricFields } from '../models/Database';

// ============================================================================
// Database advisor.
// ----------------------------------------------------------------------------
// Turns a sample into ranked, explained findings. Every rule is deterministic
// and states the observation that triggered it, so an operator can check the
// reasoning rather than trust a number.
//
// Advisory only: findings describe what to do, and Senzor never does it. No
// rule here mutates the monitored instance (see the observability-only
// constraint that governs this product).
// ============================================================================

export type AdvisorySeverity = 'critical' | 'warning' | 'info';

export interface Advisory {
  /** Stable key, so the UI can dedupe and the user can mute per finding later. */
  id: string;
  severity: AdvisorySeverity;
  title: string;
  /** What was actually observed, including the number that tripped the rule. */
  detail: string;
  remediation: string;
}

export interface HealthReport {
  /** 0-100. Derived purely from the findings below — never a separate opinion. */
  score: number;
  advisories: Advisory[];
}

/** Penalty weights. Kept small and explicit so the score stays explainable. */
const PENALTY: Record<AdvisorySeverity, number> = { critical: 25, warning: 10, info: 0 };

const pct = (n: number) => `${n.toFixed(1)}%`;
const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

const plural = (value: number, unit: string, decimals = 0) => {
  const shown = value.toFixed(decimals);
  return `${shown} ${Number(shown) === 1 ? unit : `${unit}s`}`;
};

const hours = (seconds: number) => {
  if (seconds >= 86400) return plural(seconds / 86400, 'day', 1);
  if (seconds >= 3600) return plural(seconds / 3600, 'hour', 1);
  if (seconds >= 60) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
};

/** Present and finite. Distinguishes "not collected" from a genuine zero. */
const has = (v: number | undefined | null): v is number => typeof v === 'number' && Number.isFinite(v);

type Metric = Partial<IDbMetricFields>;

interface AdvisorInput {
  type: 'mongodb' | 'postgresql' | 'mysql' | 'redis';
  status: 'online' | 'offline' | 'error';
  errorMessage?: string;
  latest: Metric;
}

const universalRules = ({ status, errorMessage, latest }: AdvisorInput, out: Advisory[]) => {
  if (status === 'error') {
    out.push({
      id: 'connection-failed',
      severity: 'critical',
      title: 'Last collection attempt failed',
      detail: errorMessage || 'The most recent poll could not reach this instance.',
      remediation: 'Check network reachability, credentials, and that the instance is accepting connections.',
    });
  }

  const current = latest.connections?.current;
  const available = latest.connections?.available;
  if (has(current) && has(available)) {
    const capacity = current + available;
    if (capacity > 0) {
      const used = (current / capacity) * 100;
      if (used >= 90) {
        out.push({
          id: 'connection-saturation',
          severity: 'critical',
          title: 'Connection pool near capacity',
          detail: `${current} of ${capacity} connections in use (${pct(used)}).`,
          remediation: 'Raise the connection limit, or reduce client-side pool sizes. New connections are refused once the limit is reached.',
        });
      } else if (used >= 75) {
        out.push({
          id: 'connection-pressure',
          severity: 'warning',
          title: 'Connection usage is high',
          detail: `${current} of ${capacity} connections in use (${pct(used)}).`,
          remediation: 'Review client pool sizing before the limit is reached.',
        });
      }
    }
  }
};

const mongoRules = ({ latest }: AdvisorInput, out: Advisory[]) => {
  const m = latest.mongo;
  if (!m) return;

  if (has(m.cacheUsedPercent) && m.cacheUsedPercent >= 95) {
    out.push({
      id: 'mongo-cache-pressure',
      severity: 'warning',
      title: 'WiredTiger cache is full',
      detail: `Cache is ${pct(m.cacheUsedPercent)} full${has(m.cacheEvictionsRate) ? `, evicting ${num(m.cacheEvictionsRate)} pages/sec` : ''}.`,
      remediation: 'Increase the WiredTiger cache size, or reduce the working set. Sustained eviction forces reads back to disk.',
    });
  }

  const noTickets = (has(m.ticketsAvailableRead) && m.ticketsAvailableRead === 0)
    || (has(m.ticketsAvailableWrite) && m.ticketsAvailableWrite === 0);
  if (noTickets) {
    out.push({
      id: 'mongo-tickets-exhausted',
      severity: 'critical',
      title: 'Concurrency tickets exhausted',
      detail: `No execution slots free (read: ${m.ticketsAvailableRead ?? 'n/a'}, write: ${m.ticketsAvailableWrite ?? 'n/a'}). Operations are queueing.`,
      remediation: 'Find the slow operations holding slots. Ticket exhaustion is almost always downstream of unindexed queries or disk saturation.',
    });
  }

  if (has(m.scanRatio) && m.scanRatio > 1) {
    if (m.scanRatio >= 100) {
      out.push({
        id: 'mongo-scan-ratio-critical',
        severity: 'critical',
        title: 'Queries are scanning heavily',
        detail: `${num(m.scanRatio)} documents examined per document returned.`,
        remediation: 'Queries are running without a selective index. Review the slowest operations and add covering indexes.',
      });
    } else if (m.scanRatio >= 10) {
      out.push({
        id: 'mongo-scan-ratio',
        severity: 'warning',
        title: 'Index efficiency is poor',
        detail: `${num(m.scanRatio)} documents examined per document returned.`,
        remediation: 'A well-indexed workload approaches 1. Review query shapes against existing indexes.',
      });
    }
  }

  if (has(m.oplogWindowSeconds) && m.oplogWindowSeconds > 0 && m.oplogWindowSeconds < 3600) {
    out.push({
      id: 'mongo-oplog-window',
      severity: 'warning',
      title: 'Oplog window is short',
      detail: `The oplog holds ${hours(m.oplogWindowSeconds)} of history.`,
      remediation: 'A secondary offline longer than this window needs a full resync. Increase the oplog size.',
    });
  }

  if (has(m.replicationLagMs) && m.replicationLagMs > 10_000) {
    out.push({
      id: 'mongo-replication-lag',
      severity: 'warning',
      title: 'Secondary is lagging',
      detail: `Worst secondary is ${hours(m.replicationLagMs / 1000)} behind the primary.`,
      remediation: 'Check secondary disk throughput and network. Reads with secondary preference will return stale data.',
    });
  }
};

const postgresRules = ({ latest }: AdvisorInput, out: Advisory[]) => {
  const p = latest.pg;
  const sql = latest.sql;

  if (sql && has(sql.cacheHitRate) && sql.cacheHitRate > 0 && sql.cacheHitRate < 95) {
    out.push({
      id: 'pg-cache-hit',
      severity: 'warning',
      title: 'Buffer cache hit rate is low',
      detail: `${pct(sql.cacheHitRate)} of block reads were served from shared buffers.`,
      remediation: 'Healthy OLTP workloads sit above 99%. Consider increasing shared_buffers or reviewing the working set.',
    });
  }

  if (!p) return;

  if (has(p.xidAgePercent)) {
    if (p.xidAgePercent >= 75) {
      out.push({
        id: 'pg-xid-wraparound-critical',
        severity: 'critical',
        title: 'Transaction ID wraparound approaching',
        detail: `${pct(p.xidAgePercent)} of the transaction ID budget consumed.`,
        remediation: 'Run VACUUM FREEZE on the oldest tables. PostgreSQL stops accepting writes if this reaches 100%.',
      });
    } else if (p.xidAgePercent >= 50) {
      out.push({
        id: 'pg-xid-wraparound',
        severity: 'warning',
        title: 'Transaction ID age is elevated',
        detail: `${pct(p.xidAgePercent)} of the transaction ID budget consumed.`,
        remediation: 'Check that autovacuum is keeping up; look for long-running transactions holding back the freeze horizon.',
      });
    }
  }

  if (has(p.deadTuples) && has(p.liveTuples) && p.liveTuples > 1000) {
    const bloat = (p.deadTuples / (p.liveTuples + p.deadTuples)) * 100;
    if (bloat >= 20) {
      out.push({
        id: 'pg-dead-tuples',
        severity: 'warning',
        title: 'Dead tuple accumulation',
        detail: `${num(p.deadTuples)} dead tuples, ${pct(bloat)} of all rows.`,
        remediation: 'Autovacuum is falling behind. Tune autovacuum_vacuum_scale_factor on the affected tables.',
      });
    }
  }

  if (has(p.idleInTransaction) && p.idleInTransaction >= 5) {
    out.push({
      id: 'pg-idle-in-transaction',
      severity: 'warning',
      title: 'Sessions idle in transaction',
      detail: `${p.idleInTransaction} sessions are holding open transactions without doing work.`,
      remediation: 'These block vacuum and hold locks. Set idle_in_transaction_session_timeout, and check for clients that forget to commit.',
    });
  }

  if (has(p.longestTransactionSeconds) && p.longestTransactionSeconds >= 3600) {
    out.push({
      id: 'pg-long-transaction',
      severity: 'warning',
      title: 'Very long-running transaction',
      detail: `Oldest transaction has been open for ${hours(p.longestTransactionSeconds)}.`,
      remediation: 'Long transactions pin the vacuum horizon and inflate table bloat. Identify and close it.',
    });
  }

  if (
    has(p.checkpointsRequestedRate) && has(p.checkpointsTimedRate) &&
    p.checkpointsRequestedRate > p.checkpointsTimedRate && p.checkpointsRequestedRate > 0
  ) {
    out.push({
      id: 'pg-checkpoint-pressure',
      severity: 'warning',
      title: 'Checkpoints are being forced',
      detail: `Requested checkpoints (${num(p.checkpointsRequestedRate)}/sec) outpace scheduled ones (${num(p.checkpointsTimedRate)}/sec).`,
      remediation: 'WAL is filling before the scheduled interval. Increase max_wal_size to smooth write spikes.',
    });
  }

  if (has(p.tempFilesRate) && p.tempFilesRate > 0) {
    out.push({
      id: 'pg-temp-files',
      severity: 'info',
      title: 'Queries are spilling to disk',
      detail: `${num(p.tempFilesRate)} temp files/sec created.`,
      remediation: 'Sorts and hashes exceed work_mem and are spilling to disk. Raising work_mem trades memory for speed here.',
    });
  }

  if (has(p.replicationSlotLagBytes) && p.replicationSlotLagBytes > 1024 ** 3) {
    out.push({
      id: 'pg-slot-lag',
      severity: 'warning',
      title: 'Replication slot is retaining WAL',
      detail: `${num(p.replicationSlotLagBytes / 1024 ** 3)} GB of WAL held by the furthest-behind slot.`,
      remediation: 'An inactive or slow slot will fill the WAL volume. Drop unused slots, or set max_slot_wal_keep_size.',
    });
  }
};

const mysqlRules = ({ latest }: AdvisorInput, out: Advisory[]) => {
  const my = latest.mysql;
  const sql = latest.sql;

  if (sql && has(sql.cacheHitRate) && sql.cacheHitRate > 0 && sql.cacheHitRate < 95) {
    out.push({
      id: 'mysql-buffer-pool',
      severity: 'warning',
      title: 'InnoDB buffer pool hit rate is low',
      detail: `${pct(sql.cacheHitRate)} of reads were served from the buffer pool.`,
      remediation: 'Increase innodb_buffer_pool_size so the working set fits in memory.',
    });
  }

  if (!my) return;

  if (has(my.historyListLength)) {
    if (my.historyListLength >= 1_000_000) {
      out.push({
        id: 'mysql-history-list-critical',
        severity: 'critical',
        title: 'InnoDB purge is far behind',
        detail: `History list length is ${num(my.historyListLength)}.`,
        remediation: 'Undo logs are accumulating faster than purge can clear them. Find and close long-running transactions.',
      });
    } else if (my.historyListLength >= 100_000) {
      out.push({
        id: 'mysql-history-list',
        severity: 'warning',
        title: 'InnoDB history list is growing',
        detail: `History list length is ${num(my.historyListLength)}.`,
        remediation: 'Sustained growth inflates the undo tablespace and slows reads. Check for long transactions.',
      });
    }
  }

  if (has(my.rowLockWaitsRate) && my.rowLockWaitsRate > 0) {
    out.push({
      id: 'mysql-row-locks',
      severity: 'warning',
      title: 'Row lock contention',
      detail: `${num(my.rowLockWaitsRate)} lock waits/sec${has(my.rowLockTimeAvgMs) ? `, averaging ${num(my.rowLockTimeAvgMs)}ms` : ''}.`,
      remediation: 'Transactions are competing for the same rows. Shorten transactions and review access ordering.',
    });
  }

  if (has(my.tmpDiskTablesRate) && my.tmpDiskTablesRate >= 1) {
    out.push({
      id: 'mysql-tmp-disk-tables',
      severity: 'warning',
      title: 'Temporary tables spilling to disk',
      detail: `${num(my.tmpDiskTablesRate)} on-disk temp tables/sec.`,
      remediation: 'Raise tmp_table_size and max_heap_table_size, or rewrite the queries producing large intermediate results.',
    });
  }

  if (has(my.innodbLogWaitsRate) && my.innodbLogWaitsRate > 0) {
    out.push({
      id: 'mysql-log-waits',
      severity: 'warning',
      title: 'Redo log buffer waits',
      detail: `${num(my.innodbLogWaitsRate)} waits/sec for redo log buffer space.`,
      remediation: 'Increase innodb_log_buffer_size. Writes are stalling while the buffer flushes.',
    });
  }

  if (has(my.abortedConnectsRate) && my.abortedConnectsRate > 0) {
    out.push({
      id: 'mysql-aborted-connects',
      severity: 'warning',
      title: 'Connections are being aborted',
      detail: `${num(my.abortedConnectsRate)} aborted connection attempts/sec.`,
      remediation: 'Usually failed authentication or network interruption. Check credentials and client timeouts.',
    });
  }

  if (sql && has(sql.replicationLagMs) && sql.replicationLagMs > 10_000) {
    out.push({
      id: 'mysql-replication-lag',
      severity: 'warning',
      title: 'Replica is lagging',
      detail: `Replica is ${hours(sql.replicationLagMs / 1000)} behind the source.`,
      remediation: 'Check replica disk throughput and whether replication is single-threaded for this workload.',
    });
  }
};

const redisRules = ({ latest }: AdvisorInput, out: Advisory[]) => {
  const r = latest.redis;
  if (!r) return;

  // -1 is the sentinel for "no maxmemory configured", which is a different
  // situation from 0% of a configured bound.
  if (has(r.memoryUsedPercent) && r.memoryUsedPercent >= 0) {
    if (r.memoryUsedPercent >= 90) {
      out.push({
        id: 'redis-memory-critical',
        severity: 'critical',
        title: 'Memory limit nearly reached',
        detail: `${pct(r.memoryUsedPercent)} of maxmemory in use.`,
        remediation: 'Raise maxmemory or reduce the dataset. Behaviour at the limit depends on the eviction policy.',
      });
    } else if (r.memoryUsedPercent >= 75) {
      out.push({
        id: 'redis-memory-pressure',
        severity: 'warning',
        title: 'Memory usage is high',
        detail: `${pct(r.memoryUsedPercent)} of maxmemory in use.`,
        remediation: 'Plan capacity now, before evictions begin.',
      });
    }
  }

  if (has(r.evictedKeys) && r.evictedKeys > 0) {
    out.push({
      id: 'redis-evictions',
      severity: 'warning',
      title: 'Keys are being evicted',
      detail: `${num(r.evictedKeys)} keys/sec evicted under memory pressure.`,
      remediation: 'Data is being discarded to stay under maxmemory. Increase memory, or confirm the eviction policy matches intent.',
    });
  }

  const lookups = (r.keyspaceHits || 0) + (r.keyspaceMisses || 0);
  if (lookups > 1 && has(r.hitRate) && r.hitRate < 80) {
    out.push({
      id: 'redis-hit-rate',
      severity: 'warning',
      title: 'Cache hit rate is low',
      detail: `${pct(r.hitRate)} of key lookups hit.`,
      remediation: 'Frequent misses suggest keys are expiring too early or the cache is undersized for the access pattern.',
    });
  }

  if (has(r.fragmentationRatio) && r.fragmentationRatio > 1.5) {
    out.push({
      id: 'redis-fragmentation',
      severity: 'warning',
      title: 'Memory is fragmented',
      detail: `Fragmentation ratio is ${num(r.fragmentationRatio)}.`,
      remediation: 'The allocator holds more memory than the dataset needs. Enable activedefrag, or restart during a maintenance window.',
    });
  }

  if (r.rdbLastBgsaveOk === 0) {
    out.push({
      id: 'redis-rdb-failed',
      severity: 'critical',
      title: 'Last RDB snapshot failed',
      detail: 'The most recent background save did not complete successfully.',
      remediation: 'Check disk space and permissions on the RDB directory. Persistence is not currently protecting this data.',
    });
  }

  if (r.aofLastWriteOk === 0) {
    out.push({
      id: 'redis-aof-failed',
      severity: 'critical',
      title: 'Last AOF write failed',
      detail: 'The append-only file could not be written.',
      remediation: 'Check disk space and permissions. Writes are not being durably recorded.',
    });
  }

  if (r.masterLinkUp === 0) {
    out.push({
      id: 'redis-replica-disconnected',
      severity: 'critical',
      title: 'Replica is disconnected from its primary',
      detail: 'The replication link is down; this replica is serving stale data.',
      remediation: 'Check network reachability and primary authentication.',
    });
  }

  if (has(r.blockedClients) && r.blockedClients > 0) {
    out.push({
      id: 'redis-blocked-clients',
      severity: 'info',
      title: 'Clients are blocked',
      detail: `${r.blockedClients} clients waiting on blocking commands.`,
      remediation: 'Expected with BLPOP-style consumers. Investigate only if the count is unexpected or growing.',
    });
  }
};

const SEVERITY_ORDER: Record<AdvisorySeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Evaluates every applicable rule against the latest sample.
 * Returns findings ranked most severe first, and a score derived from them.
 */
export const buildHealthReport = (input: AdvisorInput): HealthReport => {
  const advisories: Advisory[] = [];

  universalRules(input, advisories);
  if (input.type === 'mongodb') mongoRules(input, advisories);
  if (input.type === 'postgresql') postgresRules(input, advisories);
  if (input.type === 'mysql') mysqlRules(input, advisories);
  if (input.type === 'redis') redisRules(input, advisories);

  advisories.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const penalty = advisories.reduce((sum, a) => sum + PENALTY[a.severity], 0);
  return { score: Math.max(0, 100 - penalty), advisories };
};
