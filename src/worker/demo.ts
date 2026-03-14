import cron from 'node-cron';
import { logger } from '../utils/logger';
import { getRandomStatus } from '../controllers/demo';

export const startDemoWorker = () => {
  logger.info('[Worker] System Demo Service Scheduled');

  cron.schedule('*/15 * * * *', async () => {
    try {
      const req: any = {};
      await getRandomStatus(req, req);
    } catch (error) {
      logger.error('[Worker] Demo encountered an unhandled exception:', error);
    }
  }, {
    name: 'senzor-internal-task-demo',
    timezone: 'UTC'
  });
};