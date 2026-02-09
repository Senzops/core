import { Request, Response } from 'express';
import axios from 'axios';

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

const randomInt = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const randomBool = () => Math.random() > 0.5;

const FINAL_STATUSES = [
  200, 201, 202,
  400, 401, 403, 404,
  429,
  500, 502, 503
];

const EXTERNAL_ENDPOINTS = [
  () => `https://httpstat.us/${FINAL_STATUSES[randomInt(0, FINAL_STATUSES.length - 1)]}`,
  () => `https://jsonplaceholder.typicode.com/posts/${randomInt(1, 150)}`,
  () => `https://api.agify.io?name=user${randomInt(1, 1000)}`,
  () => `https://api.genderize.io?name=name${randomInt(1, 1000)}`
];

async function makeRequest(url: string) {
  const useAxios = randomBool();

  try {
    if (useAxios) {
      const res = await axios.get(url, { timeout: 3000 });
      return {
        client: 'axios',
        url,
        status: res.status,
        success: true
      };
    } else {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return {
        client: 'fetch',
        url,
        status: res.status,
        success: res.ok
      };
    }
  } catch (err: any) {
    return {
      client: useAxios ? 'axios' : 'fetch',
      url,
      status: err?.response?.status ?? 0,
      success: false,
      error: err.message
    };
  }
}

export const getRandomStatus = async (req: Request, res: Response) => {
  const requestCount = randomInt(1, 6);
  const results = [];

  for (let i = 0; i < requestCount; i++) {
    const url =
      EXTERNAL_ENDPOINTS[randomInt(0, EXTERNAL_ENDPOINTS.length - 1)]();

    results.push(await makeRequest(url));

    if (i < requestCount - 1) {
      await sleep(randomInt(100, 1200));
    }
  }

  // Random final latency (like edge buffering or aggregation delay)
  const finalDelay = randomInt(50, 800);
  await sleep(finalDelay);

  // 🔥 RANDOM FINAL STATUS
  const finalStatus =
    FINAL_STATUSES[randomInt(0, FINAL_STATUSES.length - 1)];

  return res.status(finalStatus).json({
    status:
      finalStatus >= 200 && finalStatus < 300
        ? 'operational'
        : finalStatus >= 400 && finalStatus < 500
          ? 'client_error'
          : 'server_error',
    final_http_status: finalStatus,
    external_requests_made: requestCount,
    latency_simulated: finalDelay,
    timestamp: new Date().toISOString(),
    upstream_results: results
  });
};
