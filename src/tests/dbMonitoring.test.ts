// ============================================================================
// Database monitoring — regression suite
// ----------------------------------------------------------------------------
// Plain runnable script, matching the convention of the other tests in this
// directory (no framework is configured; each exits 0 on pass, 1 on failure).
//
//   npm run test:db
//
// Covers the pure logic behind Database Monitoring. Deliberately no I/O: every
// case here must hold regardless of which engine happens to be reachable.
//
// The connection-scope section exists because of a real production regression:
// storage was read through the driver's default database handle, which silently
// resolves to `test` when the connection string names no database — reporting
// 0 bytes for clusters that were plainly not empty.
// ============================================================================
import { databaseFromUri, summariseStorage } from '../worker/database/adapters/mongo';
import {
  redactMongoCommand,
  redactRedisCommand,
  normalizeSqlText,
  digestOf,
} from '../worker/database/redact';
import { analyzeIndexes, buildIndexAdvisories, suggestMongoIndex } from '../services/dbIndexAdvisor';
import { buildHealthReport } from '../services/dbAdvisor';
import type { IIndexEntry } from '../models/DbIndexStat';

let failures = 0;
let checks = 0;

const check = (label: string, condition: boolean, detail?: string) => {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
};

const eq = (label: string, actual: unknown, expected: unknown) =>
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const section = (name: string) => console.log(`\n${name}`);

// ---------------------------------------------------------------------------
section('Connection scope — databaseFromUri');
// ---------------------------------------------------------------------------
eq('names a database', databaseFromUri('mongodb://u:p@host:27017/appdb'), 'appdb');
eq('names a database (srv)', databaseFromUri('mongodb+srv://u:p@cluster.net/appdb'), 'appdb');
eq('strips the query string', databaseFromUri('mongodb+srv://u:p@c.net/appdb?retryWrites=true'), 'appdb');
eq('no path -> cluster scope', databaseFromUri('mongodb+srv://u:p@cluster.net'), null);
eq('bare slash -> cluster scope', databaseFromUri('mongodb+srv://u:p@cluster.net/'), null);
eq('slash + query -> cluster scope', databaseFromUri('mongodb+srv://u:p@c.net/?retryWrites=true'), null);
eq('multi-host, no database', databaseFromUri('mongodb://a:1,b:2,c:3/?replicaSet=rs0'), null);
eq('multi-host with database', databaseFromUri('mongodb://a:1,b:2/appdb?replicaSet=rs0'), 'appdb');
// Credentials must be percent-encoded per the connection-string spec, so an
// encoded slash in a password can never be mistaken for the path separator.
eq('encoded slash in password', databaseFromUri('mongodb://user:p%2Fss@host/appdb'), 'appdb');
eq('percent-encoded database name', databaseFromUri('mongodb://h/my%20db'), 'my db');
eq('a database actually called test', databaseFromUri('mongodb://h/test'), 'test');
eq('garbage input is not fatal', databaseFromUri('not a uri'), null);
eq('empty input is not fatal', databaseFromUri(''), null);

// ---------------------------------------------------------------------------
section('Redaction — values never leave the collector');
// ---------------------------------------------------------------------------
{
  const out = redactMongoCommand({
    op: 'query',
    ns: 'app.users',
    command: {
      find: 'users',
      filter: { email: 'alice@example.com', age: { $gt: 30 }, token: 'sk_live_9f8a' },
      sort: { createdAt: -1 },
    },
  });
  check('mongo: no literal values survive',
    !/alice@example\.com|sk_live_9f8a|30/.test(out), out);
  check('mongo: shape survives',
    out.includes('email') && out.includes('$gt') && out.includes('createdAt'), out);
}
{
  const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);
  const out = redactMongoCommand({ command: { find: 'orders', filter: { _id: { $in: ids } } } });
  check('mongo: large $in collapses', out.includes('+499') && out.length < 200, out);
  check('mongo: no element values leak', !out.includes('id-250'), out);
}
{
  const bson = { _bsontype: 'ObjectId', toString: () => '65f1a2b3c4d5e6f7a8b9c0d1' };
  const out = redactMongoCommand({ command: { filter: { _id: bson, at: new Date('2024-01-01') } } });
  check('mongo: BSON scalars and dates redact',
    !out.includes('65f1a2b3') && !out.includes('2024-01-01'), out);
}
{
  // Deeply nested input must terminate rather than recurse without bound.
  const deep: any = {};
  let cur = deep;
  for (let i = 0; i < 60; i++) { cur.next = {}; cur = cur.next; }
  const out = redactMongoCommand({ command: deep });
  check('mongo: depth is bounded', typeof out === 'string' && out.length > 0);
}
eq('redis: key reduced to its namespace', redactRedisCommand(['GET', 'user:a1b2:email']), 'GET user:*');
check('redis: payload dropped',
  !redactRedisCommand(['SET', 'session:x', 'super-secret']).includes('super-secret'));
check('redis: credentials never surface',
  !redactRedisCommand(['AUTH', 'hunter2']).includes('hunter2'));
eq('redis: unprefixed key generalised', redactRedisCommand(['DEL', 'flatkey']), 'DEL *');
eq('redis: verb-only survives', redactRedisCommand(['PING']), 'PING');
eq('redis: empty is safe', redactRedisCommand([]), '[empty]');
{
  const out = normalizeSqlText("SELECT * FROM u WHERE email = 'bob@corp.io' AND id IN ($1,$2,$3)");
  check('sql: literal removed', !out.includes('bob@corp.io'), out);
  check('sql: IN list collapsed', out.includes('IN (...)'), out);
  check('sql: structure kept', out.includes('SELECT') && out.includes('email'), out);
}
check('digest is stable', digestOf('SELECT 1') === digestOf('SELECT 1'));
check('digest distinguishes shapes', digestOf('SELECT 1') !== digestOf('SELECT 2'));
check('text is bounded', normalizeSqlText('SELECT ' + 'a,'.repeat(5000)).length <= 4020);

// ---------------------------------------------------------------------------
section('Index advisor');
// ---------------------------------------------------------------------------
const idx = (o: Partial<IIndexEntry>): IIndexEntry => ({
  namespace: 'app.users', name: 'i', definition: '', keys: [], unique: false,
  primary: false, partial: false, sizeBytes: 0, scans: 0, flags: [], ...o,
} as IIndexEntry);

const LONG_UPTIME = 30 * 86400;
{
  const out = analyzeIndexes([
    idx({ name: 'a_1', keys: ['a'], scans: 100 }),
    idx({ name: 'a_1_b_1', keys: ['a', 'b'], scans: 100 }),
  ], LONG_UPTIME);
  check('{a} is redundant beside {a,b}', out[0].flags.includes('redundant'));
  eq('names the covering index', out[0].redundantWith, 'a_1_b_1');
  check('{a,b} is not flagged', !out[1].flags.includes('redundant'));
}
{
  // Order matters: {b} is NOT a prefix of {a,b}.
  const out = analyzeIndexes([
    idx({ name: 'b_1', keys: ['b'], scans: 5 }),
    idx({ name: 'a_1_b_1', keys: ['a', 'b'], scans: 5 }),
  ], LONG_UPTIME);
  check('{b} is not redundant beside {a,b}', !out[0].flags.includes('redundant'));
}
{
  const out = analyzeIndexes([
    idx({ name: 'email_uniq', keys: ['email'], unique: true, scans: 900 }),
    idx({ name: 'email_1_ts_1', keys: ['email', 'ts'], scans: 900 }),
  ], LONG_UPTIME);
  check('a unique index is never redundant', out[0].flags.length === 0, JSON.stringify(out[0].flags));
}
{
  const out = analyzeIndexes([
    idx({ namespace: 'app.users', name: 'a_1', keys: ['a'], scans: 1 }),
    idx({ namespace: 'app.orders', name: 'a_1_b_1', keys: ['a', 'b'], scans: 1 }),
  ], LONG_UPTIME);
  check('redundancy is scoped per namespace', !out[0].flags.includes('redundant'));
}
check('unused needs meaningful uptime',
  !analyzeIndexes([idx({ name: 'z', keys: ['z'] })], 3600)[0].flags.includes('unused'));
check('unused after long uptime',
  analyzeIndexes([idx({ name: 'z', keys: ['z'] })], LONG_UPTIME)[0].flags.includes('unused'));
check('primary key is never flagged unused',
  analyzeIndexes([idx({ name: '_id_', keys: ['_id'], primary: true })], LONG_UPTIME)[0].flags.length === 0);
eq('ESR ordering for suggestions',
  suggestMongoIndex(JSON.stringify({ filter: { status: '?', age: { $gt: '?' } }, sort: { createdAt: -1 } })),
  '{ "status": 1, "createdAt": 1, "age": 1 }');
eq('unparseable shape suggests nothing', suggestMongoIndex('not json'), null);
eq('no filter suggests nothing', suggestMongoIndex(JSON.stringify({ find: '?' })), null);
{
  const analyzed = analyzeIndexes([idx({ name: 'stale', keys: ['s'], sizeBytes: 300 * 1024 * 1024 })], LONG_UPTIME);
  const adv = buildIndexAdvisories('mongodb', analyzed, LONG_UPTIME, [
    { digestHash: 'd1', queryText: JSON.stringify({ filter: { email: '?' } }), namespace: 'app.users', executions: 5000, examinedPerReturned: 250 },
    { digestHash: 'd2', queryText: '{}', namespace: 'app.x', executions: 3, examinedPerReturned: 2 },
  ]);
  check('unused advisory raised', adv.some((a) => a.id === 'index-unused'));
  check('missing-index candidate raised', adv.some((a) => a.id.startsWith('index-missing-d1')));
  check('well-targeted shape ignored', !adv.some((a) => a.id.includes('d2')));
  check('suggested DDL is text only', adv.some((a) => a.remediation.includes('dropIndex')));
  check('every advisory is complete',
    adv.every((a) => !!a.id && !!a.title && !!a.detail && !!a.remediation && !!a.severity));
  check('redis produces no index advice', buildIndexAdvisories('redis', [], LONG_UPTIME, []).length === 0);
}

// ---------------------------------------------------------------------------
section('Health advisor');
// ---------------------------------------------------------------------------
{
  const healthy = buildHealthReport({
    type: 'mongodb', status: 'online',
    latest: {
      connections: { current: 10, available: 990, totalCreated: 0 },
      mongo: { cacheUsedPercent: 40, ticketsAvailableRead: 120, ticketsAvailableWrite: 120, scanRatio: 1.2 },
    } as any,
  });
  eq('a healthy instance scores 100', healthy.score, 100);
  eq('and raises nothing', healthy.advisories.length, 0);
}
{
  const bad = buildHealthReport({
    type: 'mongodb', status: 'online',
    latest: {
      connections: { current: 950, available: 50, totalCreated: 0 },
      mongo: { cacheUsedPercent: 98, ticketsAvailableRead: 0, scanRatio: 250 },
    } as any,
  });
  check('a struggling instance scores low', bad.score < 40, `score=${bad.score}`);
  const order = { critical: 0, warning: 1, info: 2 } as const;
  check('findings are ranked most severe first',
    bad.advisories.every((a, i) => i === 0 || order[bad.advisories[i - 1].severity] <= order[a.severity]));
}
{
  // -1 is the sentinel for "no maxmemory configured" and must not read as 0%.
  const r = buildHealthReport({
    type: 'redis', status: 'online',
    latest: { connections: { current: 5, available: 9995, totalCreated: 0 }, redis: { memoryUsedPercent: -1 } } as any,
  });
  check('redis without maxmemory raises no memory finding',
    !r.advisories.some((a) => a.id.startsWith('redis-memory')));
}
{
  const empty = buildHealthReport({ type: 'postgresql', status: 'online', latest: {} as any });
  eq('an empty sample raises nothing', empty.advisories.length, 0);
}
{
  const errored = buildHealthReport({
    type: 'mongodb', status: 'error', errorMessage: 'connection refused', latest: {} as any,
  });
  check('a failed poll is reported', errored.advisories.some((a) => a.id === 'connection-failed'));
}

// ---------------------------------------------------------------------------
section('Storage contract — disk, not logical');
// ---------------------------------------------------------------------------
{
  // Real dbStats output from the production cluster whose storage was
  // misreported: 1331 GB logical against 326 GB on disk (WiredTiger, 4.44x).
  // The database appeared larger than the volume holding it.
  const GB = 1024 ** 3;
  const real = summariseStorage([{
    dataSize: 1331.02 * GB,
    storageSize: 299.67 * GB,
    indexSize: 26.51 * GB,
    objects: 236_000_000,
    fsUsedSize: 384.61 * GB,
    fsTotalSize: 1006.75 * GB,
  }]);

  const asGb = (mb: number) => mb / 1024;
  const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;

  check('storageSize is the DISK footprint, not the logical size',
    near(asGb(real.storage.storageSize), 326.18), `${asGb(real.storage.storageSize).toFixed(2)} GB`);
  check('storageSize reconciles with the host filesystem',
    real.storage.storageSize < (real.diskUsedMb ?? 0), 'must not exceed disk in use');
  check('the logical size is kept, separately',
    near(asGb(real.logicalDataSizeMb), 1331.02, 0.5), `${asGb(real.logicalDataSizeMb).toFixed(2)} GB`);
  check('logical is NOT reported as storage',
    real.storage.storageSize < real.logicalDataSizeMb / 3);
  check('compression ratio is derived',
    near(real.compressionRatio ?? 0, 4.44, 0.02), String(real.compressionRatio));
  check('the contract is additive: data + index === storage',
    near(real.storage.dataSize + real.storage.indexSize, real.storage.storageSize, 0.001));
  check('filesystem usage is derived',
    near(real.diskUsedPercent ?? 0, 38.2, 0.2), String(real.diskUsedPercent));
}
{
  // Filesystem figures are per-host: several databases on one volume must not
  // multiply the disk, while the data figures do accumulate.
  const GB = 1024 ** 3;
  const doc = { dataSize: 2 * GB, storageSize: 1 * GB, indexSize: 0.5 * GB, objects: 10, fsUsedSize: 50 * GB, fsTotalSize: 100 * GB };
  const multi = summariseStorage([doc, doc, doc]);
  eq('disk in use is not multiplied', Math.round((multi.diskUsedMb ?? 0) / 1024), 50);
  eq('disk total is not multiplied', Math.round((multi.diskTotalMb ?? 0) / 1024), 100);
  eq('storage accumulates across databases', Math.round(multi.storage.storageSize / 1024), 5);
  eq('objects accumulate', multi.storage.objects, 30);
}
{
  const empty = summariseStorage([]);
  eq('no readable databases yields zero, not NaN', empty.storage.storageSize, 0);
  eq('and no compression ratio is invented', empty.compressionRatio, undefined);
  eq('and no filesystem figure is invented', empty.diskUsedPercent, undefined);
  const nulls = summariseStorage([null, undefined]);
  eq('unreadable databases are skipped', nulls.storage.storageSize, 0);
}

// ---------------------------------------------------------------------------
console.log(
  `\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`
);
process.exit(failures === 0 ? 0 : 1);
