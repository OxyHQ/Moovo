/**
 * Proves the API's runtime can mint an Oxy service token from its workload
 * identity (oxy ADR 0026), the path production uses now that Moovo holds no
 * OXY_SERVICE_API_KEY/SECRET pair.
 *
 * Why this exists: `@oxy.so/core` 1.7.0 shipped
 * `await import('../server/workloadIdentity')` with no extension in its ESM
 * build. Node's ESM resolver rejected it, the surrounding catch read that as
 * "this host cannot attest", and `serviceToken()` threw
 * `Service credentials not provided` on a task whose identity is its role.
 * tsc, the unit suites and `require()` all missed it. The only test that
 * catches that class of bug is LOADING the published package under the runtime
 * that will run it and driving the path end to end, which is what this does.
 *
 * Self-contained: one local HTTP server stands in for both the ECS container
 * credentials endpoint and Oxy's two workload routes, so nothing leaves the
 * host. The fake Oxy re-derives the SigV4 signature from the fake secret and
 * refuses a token unless it matches and covers the nonce, which is what real
 * STS and Oxy's verifier require.
 *
 * Run it from a directory whose node_modules holds the production
 * `@oxy.so/core`: in CI it is mounted into the API image at /app and run with
 * `bun` (see smoke-api-image.sh); locally, `bun .github/scripts/check-workload-attestation.mjs`
 * from the repo root.
 */
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';

const ACCESS_KEY_ID = 'ASIASMOKETESTKEY0000';
const SECRET_ACCESS_KEY = 'smoke-test-secret-not-a-real-credential';
const SESSION_TOKEN = 'smoke-test-session-token';
const NONCE = `smoke-${Date.now()}`;
const TOKEN = 'smoke.service.token';
const STS_BODY = 'Action=GetCallerIdentity&Version=2011-06-15';

const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();

/** Re-derives the SigV4 signature the SDK should have produced; returns why it is wrong, or null. */
function verifyAttestation(headers) {
  const auth = headers?.authorization ?? '';
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/sts\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
  if (!match) return `malformed authorization header: ${auth.slice(0, 40)}`;
  const [, keyId, dateStamp, region, signedHeaders, signature] = match;
  if (keyId !== ACCESS_KEY_ID) return 'signed with the wrong access key';
  if (!signedHeaders.split(';').includes('x-oxy-attestation-nonce'))
    return 'signature does not cover the nonce';
  if (headers['x-oxy-attestation-nonce'] !== NONCE) return 'wrong nonce';
  if (headers['x-amz-security-token'] !== SESSION_TOKEN) return 'session token not carried';
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(STS_BODY),
  ].join('\n');
  const scope = `${dateStamp}/${region}/sts/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    headers['x-amz-date'],
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${SECRET_ACCESS_KEY}`, dateStamp), region), 'sts'),
    'aws4_request',
  );
  const expected = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return expected === signature ? null : 'signature does not verify';
}

let attestationError = 'the token route was never called';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && req.url === '/creds') {
      return send(200, {
        AccessKeyId: ACCESS_KEY_ID,
        SecretAccessKey: SECRET_ACCESS_KEY,
        Token: SESSION_TOKEN,
      });
    }
    if (req.method === 'POST' && req.url === '/auth/service-token/workload/challenge') {
      return send(200, { data: { nonce: NONCE } });
    }
    if (req.method === 'POST' && req.url === '/auth/service-token/workload') {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        attestationError = 'token request body is not JSON';
        return send(400, { reason: attestationError });
      }
      attestationError =
        parsed.provider !== 'aws-iam'
          ? `provider ${parsed.provider}`
          : parsed.nonce !== NONCE
            ? 'body nonce mismatch'
            : verifyAttestation(parsed.attestation?.headers);
      if (attestationError) return send(401, { reason: attestationError });
      return send(200, { data: { token: TOKEN, expiresIn: 3600, appName: 'Moovo' } });
    }
    send(404, {});
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

// Exactly the environment a credential-less ECS task presents.
delete process.env.OXY_SERVICE_API_KEY;
delete process.env.OXY_SERVICE_API_SECRET;
delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `${base}/creds`;

const runtime = typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`;
let failure = null;
try {
  const { OxyServer, canAttestWorkloadIdentity } = await import('@oxy.so/core/server');
  if (!canAttestWorkloadIdentity()) {
    failure = 'canAttestWorkloadIdentity() is false with a container credentials endpoint set';
  } else {
    const token = await new OxyServer({ baseURL: base }).serviceToken();
    if (token !== TOKEN) failure = `serviceToken() returned ${JSON.stringify(token)}`;
  }
} catch (error) {
  failure = `${error instanceof Error ? error.message : String(error)} (fake Oxy saw: ${attestationError})`;
}
server.close();

if (failure) {
  console.error(`::error::workload attestation failed under ${runtime}: ${failure}`);
  process.exit(1);
}
console.log(`workload attestation minted a service token under ${runtime}`);
