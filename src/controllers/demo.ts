import { Request, Response } from 'express';

export const getRandomStatus = (req: Request, res: Response) => {
  // Simulate Random Latency (50ms - 800ms)
  const delay = Math.floor(Math.random() * 750) + 50;

  setTimeout(() => {
    const rand = Math.random();

    // 70% Chance of Success
    if (rand < 0.7) {
      return res.status(200).json({
        status: 'operational',
        latency_simulated: delay,
        timestamp: new Date().toISOString()
      });
    }

    // 15% Chance of Server Error
    if (rand < 0.85) {
      return res.status(500).json({ error: 'Simulated Internal Server Error' });
    }

    // 10% Chance of Not Found
    if (rand < 0.95) {
      return res.status(404).json({ error: 'Simulated Not Found' });
    }

    // 5% Chance of Service Unavailable
    return res.status(503).json({ error: 'Simulated Service Unavailable' });

  }, delay);
};