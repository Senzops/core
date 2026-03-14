import cron from 'node-cron';
import { runTaskWatchdogSweep } from '../services/taskWatchdog';
import { logger } from '../utils/logger';

export const startWatchdogWorker = () => {
  logger.info('[Worker] System Watchdog Service Scheduled');

  // Schedule the sweep to run every 2 minutes
  cron.schedule('*/2 * * * *', async () => {
    try {
      await runTaskWatchdogSweep();
    } catch (error) {
      logger.error('[Worker] Watchdog encountered an unhandled exception:', error);
    }
  }, {
    name: 'senzor-internal-task-watchdog',
    timezone: 'UTC'
  });
};