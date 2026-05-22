import { verifyDodoSignature } from '../controllers/billing';
import crypto from 'crypto';

// Setup test secret and payload
// 'whsec_' prefix + base64 encoded 'base64secretkey12345678901234567890'
const secret = 'whsec_YmFzZTY0c2VjcmV0a2V5MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=';
const rawSecret = 'base64secretkey12345678901234567890';
const webhookId = 'evt_123456';
const webhookTimestamp = '1716388484';
const payloadString = JSON.stringify({
  business_id: "bus_0NcJh1BDRGAiavw2GyhZJ",
  type: "subscription.updated"
});

// Compute valid signature
const secretBuffer = Buffer.from(rawSecret, 'utf8');
const signedContent = `${webhookId}.${webhookTimestamp}.${payloadString}`;
const expectedSignature = crypto
  .createHmac('sha256', secretBuffer)
  .update(signedContent)
  .digest('base64');
const signatureHeader = `v1,${expectedSignature}`;

console.log("Expected signature base64:", expectedSignature);
console.log("Signature header:", signatureHeader);

// Test 1: Verify using exact raw payload string (Should Pass)
const passResult = verifyDodoSignature({
  webhookId,
  webhookTimestamp,
  signatureHeader,
  rawBody: payloadString,
  secret
});
console.log("Test 1 Result (Raw string, should be true):", passResult);

// Test 2: Verify simulating the Express JSON parsed object toString() bug (Should Fail)
const parsedBody = JSON.parse(payloadString);
// Simulate what Express body parser + req.body.toString('utf8') does
const buggyRawBody = parsedBody.toString('utf8'); 
console.log("Buggy rawBody string:", buggyRawBody);

const failResult = verifyDodoSignature({
  webhookId,
  webhookTimestamp,
  signatureHeader,
  rawBody: buggyRawBody,
  secret
});
console.log("Test 2 Result (Buggy string, should be false):", failResult);

if (passResult === true && failResult === false) {
  console.log("All tests passed successfully!");
  process.exit(0);
} else {
  console.error("Test suite failed!");
  process.exit(1);
}
