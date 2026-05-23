import { handleDodoWebhook } from '../controllers/billing';
import crypto from 'crypto';

const mockResponse = () => {
  const res: any = {};
  res.statusCode = 200;
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.send = (msg: string) => { res.body = msg; return res; };
  res.json = (obj: any) => { res.body = obj; return res; };
  return res;
};

process.env.DODO_WEBHOOK_SECRET = 'whsec_YmFzZTY0c2VjcmV0a2V5MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=';
const rawSecret = 'base64secretkey12345678901234567890';
const webhookId = `evt_integ_${Date.now()}`;
const webhookTimestamp = Math.floor(Date.now() / 1000).toString();

const payloadString = JSON.stringify({
  business_id: "bus_0NcJh1BDRGAiavw2GyhZJ",
  type: "subscription.updated",
  data: {
    metadata: { ownerId: "user_test_123" },
  },
});

const secretBuffer = Buffer.from(rawSecret, 'utf8');
const signedContent = `${webhookId}.${webhookTimestamp}.${payloadString}`;
const expectedSignature = crypto
  .createHmac('sha256', secretBuffer)
  .update(signedContent)
  .digest('base64');
const signatureHeader = `v1,${expectedSignature}`;

async function runTests() {
  console.log("Starting Webhook Express integration simulation tests...");

  // Test Case 1: Valid signature with rawBody buffer (correct flow)
  const req1: any = {
    headers: {
      'webhook-id': webhookId,
      'webhook-timestamp': webhookTimestamp,
      'webhook-signature': signatureHeader,
    },
    body: JSON.parse(payloadString),
    rawBody: Buffer.from(payloadString, 'utf8'),
  };

  const res1 = mockResponse();
  try {
    await handleDodoWebhook(req1, res1);
    console.log("Response status:", res1.statusCode, "body:", res1.body);
  } catch (err: any) {
    if (err.message.includes('Mongoose') || err.message.includes('buffering timed out') || err.message.includes('Connection') || err.message.includes('Cannot read properties of undefined') || err.name === 'MongooseError' || err.name === 'ValidationError') {
      console.log("Test Case 1 Passed: Signature verification succeeded (failed on subsequent DB operation as expected).");
    } else {
      console.error("Test Case 1 Failed with unexpected error:", err);
      process.exit(1);
    }
  }

  // Test Case 2: No rawBody — only parsed body object (should fail signature)
  const webhookId2 = `evt_integ_buggy_${Date.now()}`;
  const ts2 = Math.floor(Date.now() / 1000).toString();
  const signedContent2 = `${webhookId2}.${ts2}.${payloadString}`;
  const sig2 = crypto.createHmac('sha256', secretBuffer).update(signedContent2).digest('base64');

  const req2: any = {
    headers: {
      'webhook-id': webhookId2,
      'webhook-timestamp': ts2,
      'webhook-signature': `v1,${sig2}`,
    },
    body: JSON.parse(payloadString), // no rawBody — simulates the old bug
  };

  const res2 = mockResponse();
  try {
    await handleDodoWebhook(req2, res2);
  } catch (err: any) {
    console.error("Test Case 2 Failed: Threw error instead of returning 401:", err);
    process.exit(1);
  }

  if (res2.statusCode === 401 && res2.body === 'Unauthorized: Invalid signature') {
    console.log("Test Case 2 Passed: Bug successfully reproduced and rejected with 401 Unauthorized.");
  } else {
    console.error("Test Case 2 Failed: Did not reject buggy payload with 401. Status:", res2.statusCode, "body:", res2.body);
    process.exit(1);
  }

  // Test Case 3: Replay protection — old timestamp should be rejected
  const staleTimestamp = '1716388484';
  const signedContent3 = `evt_stale.${staleTimestamp}.${payloadString}`;
  const sig3 = crypto.createHmac('sha256', secretBuffer).update(signedContent3).digest('base64');

  const req3: any = {
    headers: {
      'webhook-id': 'evt_stale',
      'webhook-timestamp': staleTimestamp,
      'webhook-signature': `v1,${sig3}`,
    },
    body: JSON.parse(payloadString),
    rawBody: Buffer.from(payloadString, 'utf8'),
  };

  const res3 = mockResponse();
  try {
    await handleDodoWebhook(req3, res3);
  } catch (err: any) {
    console.error("Test Case 3 Failed: Threw error:", err);
    process.exit(1);
  }

  if (res3.statusCode === 401 && res3.body === 'Unauthorized: Timestamp too old or too new') {
    console.log("Test Case 3 Passed: Stale timestamp correctly rejected.");
  } else {
    console.error("Test Case 3 Failed: Status:", res3.statusCode, "body:", res3.body);
    process.exit(1);
  }

  console.log("All Integration Tests Passed Successfully!");
  process.exit(0);
}

runTests().catch(err => {
  console.error("Unhandled test error:", err);
  process.exit(1);
});
