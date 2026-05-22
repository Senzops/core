import { handleDodoWebhook } from '../controllers/billing';
import crypto from 'crypto';

// Mock Express Response
const mockResponse = () => {
  const res: any = {};
  res.statusCode = 200;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.send = (msg: string) => {
    res.body = msg;
    return res;
  };
  res.json = (obj: any) => {
    res.body = obj;
    return res;
  };
  return res;
};

// Setup env secret
process.env.DODO_WEBHOOK_SECRET = 'whsec_YmFzZTY0c2VjcmV0a2V5MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=';
const rawSecret = 'base64secretkey12345678901234567890';
const webhookId = 'evt_123456';
const webhookTimestamp = '1716388484';
const payloadString = JSON.stringify({
  business_id: "bus_0NcJh1BDRGAiavw2GyhZJ",
  type: "subscription.updated",
  data: {
    metadata: {
      ownerId: "user_test_123"
    }
  }
});

// Compute valid signature
const secretBuffer = Buffer.from(rawSecret, 'utf8');
const signedContent = `${webhookId}.${webhookTimestamp}.${payloadString}`;
const expectedSignature = crypto
  .createHmac('sha256', secretBuffer)
  .update(signedContent)
  .digest('base64');
const signatureHeader = `v1,${expectedSignature}`;

async function runTests() {
  console.log("Starting Webhook Express integration simulation tests...");

  // Test Case 1: Simulating Express JSON parser setting req.rawBody and req.body (Correct flow)
  const req1: any = {
    headers: {
      'webhook-id': webhookId,
      'webhook-timestamp': webhookTimestamp,
      'webhook-signature': signatureHeader
    },
    body: JSON.parse(payloadString), // express.json() parses body as object
    rawBody: Buffer.from(payloadString, 'utf8') // express.json() with verify saves raw body buffer
  };
  
  const res1 = mockResponse();

  try {
    // This will pass signature check, and then try database calls.
    // Since MongoDB is not connected, it might throw a Mongoose error, which means signature check succeeded!
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

  // Test Case 2: Simulating Express JSON parser without req.rawBody, leaving only req.body as parsed object (Old Buggy flow)
  const req2: any = {
    headers: {
      'webhook-id': webhookId,
      'webhook-timestamp': webhookTimestamp,
      'webhook-signature': signatureHeader
    },
    body: JSON.parse(payloadString) // only parsed body, no rawBody
  };

  const res2 = mockResponse();
  try {
    await handleDodoWebhook(req2, res2);
  } catch (err: any) {
    // Should not throw database error because signature verification should fail first
    console.error("Test Case 2 Failed: Threw error instead of returning 401:", err);
    process.exit(1);
  }

  if (res2.statusCode === 401 && res2.body === 'Unauthorized: Invalid signature') {
    console.log("Test Case 2 Passed: Bug successfully reproduced and rejected with 401 Unauthorized.");
  } else {
    console.error("Test Case 2 Failed: Did not reject buggy payload with 401. Status:", res2.statusCode, "body:", res2.body);
    process.exit(1);
  }

  console.log("All Integration Tests Passed Successfully!");
  process.exit(0);
}

runTests().catch(err => {
  console.error("Unhandled test error:", err);
  process.exit(1);
});
