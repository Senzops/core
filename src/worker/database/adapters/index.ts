import type { DbAdapter, DbType } from './types';
import { mongoAdapter } from './mongo';
import { postgresAdapter } from './postgres';
import { mysqlAdapter } from './mysql';
import { redisAdapter } from './redis';

// Single source of truth mapping a database engine to its adapter.
const REGISTRY: Record<DbType, DbAdapter> = {
  mongodb: mongoAdapter,
  postgresql: postgresAdapter,
  mysql: mysqlAdapter,
  redis: redisAdapter,
};

export const getAdapter = (type: DbType): DbAdapter => {
  const adapter = REGISTRY[type];
  if (!adapter) throw new Error(`Unsupported database type: ${type}`);
  return adapter;
};

export const isSupportedDbType = (type: string): type is DbType => type in REGISTRY;

/** Release pooled clients for an instance across every adapter (used on delete). */
export const disposeAllAdapters = async (dbId: string): Promise<void> => {
  await Promise.all(
    Object.values(REGISTRY).map((a) => Promise.resolve(a.dispose(dbId)).catch(() => {}))
  );
};

export * from './types';
