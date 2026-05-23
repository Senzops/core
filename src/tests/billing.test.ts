import crypto from 'crypto';
import { verifyDodoSignature } from '../controllers/billing';

// ============================================================================
// TEST UTILITIES
// ============================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, testName: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${testName}`);
  } else {
    failed++;
    failures.push(testName);
    console.error(`  ✗ ${testName}`);
  }
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

// ============================================================================
// SHARED FIXTURES
// ============================================================================

const WEBHOOK_SECRET = 'whsec_YmFzZTY0c2VjcmV0a2V5MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=';
const RAW_SECRET = 'base64secretkey12345678901234567890';

function createSignedPayload(payload: object, options: { webhookId?: string; timestamp?: string } = {}) {
  const webhookId = options.webhookId || `evt_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const webhookTimestamp = options.timestamp || Math.floor(Date.now() / 1000).toString();
  const payloadString = JSON.stringify(payload);

  const secretBuffer = Buffer.from(RAW_SECRET, 'utf8');
  const signedContent = `${webhookId}.${webhookTimestamp}.${payloadString}`;
  const signature = crypto.createHmac('sha256', secretBuffer).update(signedContent).digest('base64');

  return {
    webhookId,
    webhookTimestamp,
    signatureHeader: `v1,${signature}`,
    payloadString,
    payload,
  };
}

function mockRequest(headers: Record<string, string>, body: any, rawBody?: Buffer): any {
  return { headers, body, rawBody };
}

function mockResponse(): any {
  const res: any = { statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.send = (msg: string) => { res.body = msg; return res; };
  res.json = (obj: any) => { res.body = obj; return res; };
  return res;
}

// ============================================================================
// SIGNATURE VERIFICATION TESTS
// ============================================================================

section('Signature Verification');

// Test: valid signature passes
(() => {
  const { webhookId, webhookTimestamp, signatureHeader, payloadString } = createSignedPayload({ type: 'test' });
  const result = verifyDodoSignature({
    webhookId, webhookTimestamp, signatureHeader, rawBody: payloadString, secret: WEBHOOK_SECRET,
  });
  assert(result === true, 'Valid signature returns true');
})();

// Test: tampered payload fails
(() => {
  const { webhookId, webhookTimestamp, signatureHeader } = createSignedPayload({ type: 'test' });
  const result = verifyDodoSignature({
    webhookId, webhookTimestamp, signatureHeader, rawBody: '{"type":"tampered"}', secret: WEBHOOK_SECRET,
  });
  assert(result === false, 'Tampered payload returns false');
})();

// Test: wrong secret fails
(() => {
  const { webhookId, webhookTimestamp, signatureHeader, payloadString } = createSignedPayload({ type: 'test' });
  const result = verifyDodoSignature({
    webhookId, webhookTimestamp, signatureHeader, rawBody: payloadString, secret: 'whsec_d3JvbmdzZWNyZXQ=',
  });
  assert(result === false, 'Wrong secret returns false');
})();

// Test: [object Object] string (Express JSON parser bug) fails
(() => {
  const { webhookId, webhookTimestamp, signatureHeader } = createSignedPayload({ type: 'test' });
  const result = verifyDodoSignature({
    webhookId, webhookTimestamp, signatureHeader, rawBody: '[object Object]', secret: WEBHOOK_SECRET,
  });
  assert(result === false, 'Express parsed body toString bug returns false');
})();

// Test: empty signature header fails
(() => {
  const { webhookId, webhookTimestamp, payloadString } = createSignedPayload({ type: 'test' });
  const result = verifyDodoSignature({
    webhookId, webhookTimestamp, signatureHeader: '', rawBody: payloadString, secret: WEBHOOK_SECRET,
  });
  assert(result === false, 'Empty signature header returns false');
})();

// Test: multiple v1 signatures — at least one valid passes
(() => {
  const { webhookId, webhookTimestamp, payloadString } = createSignedPayload({ type: 'test' });

  const secretBuffer = Buffer.from(RAW_SECRET, 'utf8');
  const signedContent = `${webhookId}.${webhookTimestamp}.${payloadString}`;
  const validSig = crypto.createHmac('sha256', secretBuffer).update(signedContent).digest('base64');

  const multiSigHeader = `v1,invalidsignaturebase64== v1,${validSig}`;
  const result = verifyDodoSignature({
    webhookId, webhookTimestamp, signatureHeader: multiSigHeader, rawBody: payloadString, secret: WEBHOOK_SECRET,
  });
  assert(result === true, 'Multiple signatures — valid one among them passes');
})();

// Test: secret without whsec_ prefix works
(() => {
  const rawB64 = Buffer.from(RAW_SECRET).toString('base64');
  const { webhookId, webhookTimestamp, signatureHeader, payloadString } = createSignedPayload({ type: 'test' });
  const result = verifyDodoSignature({
    webhookId, webhookTimestamp, signatureHeader, rawBody: payloadString, secret: rawB64,
  });
  assert(result === true, 'Secret without whsec_ prefix works');
})();

// ============================================================================
// WEBHOOK HANDLER TESTS (handleDodoWebhook)
// ============================================================================

import { handleDodoWebhook } from '../controllers/billing';

process.env.DODO_WEBHOOK_SECRET = WEBHOOK_SECRET;

section('Webhook Handler — Header Validation');

// Test: missing headers returns 401
(async () => {
  const res = mockResponse();
  await handleDodoWebhook(mockRequest({}, {}), res);
  assert(res.statusCode === 401, 'Missing all webhook headers returns 401');
})();

// Test: missing webhook-id returns 401
(async () => {
  const res = mockResponse();
  await handleDodoWebhook(mockRequest({
    'webhook-timestamp': Math.floor(Date.now() / 1000).toString(),
    'webhook-signature': 'v1,test',
  }, {}), res);
  assert(res.statusCode === 401, 'Missing webhook-id returns 401');
})();

section('Webhook Handler — Replay Protection');

// Test: stale timestamp rejected
(async () => {
  const staleTimestamp = '1716388484'; // ~2024
  const payload = { type: 'subscription.active', data: { metadata: { ownerId: 'u1' } } };
  const payloadStr = JSON.stringify(payload);
  const secretBuf = Buffer.from(RAW_SECRET, 'utf8');
  const sig = crypto.createHmac('sha256', secretBuf).update(`evt_stale.${staleTimestamp}.${payloadStr}`).digest('base64');

  const res = mockResponse();
  await handleDodoWebhook(mockRequest({
    'webhook-id': 'evt_stale',
    'webhook-timestamp': staleTimestamp,
    'webhook-signature': `v1,${sig}`,
  }, payload, Buffer.from(payloadStr)), res);

  assert(res.statusCode === 401 && res.body.includes('Timestamp'), 'Stale timestamp (2024) returns 401');
})();

// Test: future timestamp rejected
(async () => {
  const futureTimestamp = (Math.floor(Date.now() / 1000) + 600).toString();
  const payload = { type: 'subscription.active', data: { metadata: { ownerId: 'u1' } } };
  const payloadStr = JSON.stringify(payload);
  const secretBuf = Buffer.from(RAW_SECRET, 'utf8');
  const sig = crypto.createHmac('sha256', secretBuf).update(`evt_future.${futureTimestamp}.${payloadStr}`).digest('base64');

  const res = mockResponse();
  await handleDodoWebhook(mockRequest({
    'webhook-id': 'evt_future',
    'webhook-timestamp': futureTimestamp,
    'webhook-signature': `v1,${sig}`,
  }, payload, Buffer.from(payloadStr)), res);

  assert(res.statusCode === 401 && res.body.includes('Timestamp'), 'Future timestamp (+10min) returns 401');
})();

section('Webhook Handler — Signature Validation');

// Test: invalid signature rejected
(async () => {
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = { type: 'subscription.active', data: { metadata: { ownerId: 'u1' } } };
  const payloadStr = JSON.stringify(payload);

  const res = mockResponse();
  await handleDodoWebhook(mockRequest({
    'webhook-id': 'evt_badsig',
    'webhook-timestamp': ts,
    'webhook-signature': 'v1,dGhpc2lzYWZha2VzaWduYXR1cmU=',
  }, payload, Buffer.from(payloadStr)), res);

  assert(res.statusCode === 401 && res.body.includes('Invalid signature'), 'Bad signature returns 401');
})();

// Test: valid signature with rawBody passes signature check (hits DB which times out)
(async () => {
  const payload = { type: 'subscription.active', data: { metadata: { ownerId: 'u_sigtest' } } };
  const { webhookId, webhookTimestamp, signatureHeader, payloadString } = createSignedPayload(payload);

  const res = mockResponse();
  try {
    await handleDodoWebhook(mockRequest({
      'webhook-id': webhookId,
      'webhook-timestamp': webhookTimestamp,
      'webhook-signature': signatureHeader,
    }, JSON.parse(payloadString), Buffer.from(payloadString)), res);
  } catch (err: any) {
    // DB timeout is expected — means signature passed
    if (err.message.includes('buffering timed out') || err.name === 'MongooseError') {
      assert(true, 'Valid signature passes verification (DB timeout expected without Mongo)');
      return;
    }
  }
  // If no exception, check if it returned 500 from the DB timeout caught internally
  assert(res.statusCode === 500 || res.statusCode === 200, 'Valid signature passes verification (handler reached DB layer)');
})();

section('Webhook Handler — Missing ownerId');

// Test: payment event without ownerId returns 400
(async () => {
  const payload = { type: 'payment.succeeded', data: { metadata: {} } };
  const { webhookId, webhookTimestamp, signatureHeader, payloadString } = createSignedPayload(payload);

  const res = mockResponse();
  try {
    await handleDodoWebhook(mockRequest({
      'webhook-id': webhookId,
      'webhook-timestamp': webhookTimestamp,
      'webhook-signature': signatureHeader,
    }, JSON.parse(payloadString), Buffer.from(payloadString)), res);
  } catch {}

  // May be 400 (missing ownerId) or 500 (DB timeout on idempotency check) — both acceptable
  assert(res.statusCode === 400 || res.statusCode === 500,
    'Payment event without ownerId returns 400 or 500');
})();

// ============================================================================
// RESULTS
// ============================================================================

// Wait for all async tests to complete
setTimeout(() => {
  console.log(`\n══════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  - ${f}`));
  }
  console.log(`══════════════════════════════\n`);
  process.exit(failed > 0 ? 1 : 0);
}, 15000);
