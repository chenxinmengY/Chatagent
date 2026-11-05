import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { randomBytes, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { startService } from '../apps/service/server.mjs';
import { readDeviceTlsOptions } from '../packages/devices/tls-config.mjs';
import { sandbox } from './helpers.mjs';

test('设备HTTPS使用真实TLS握手和证书校验，管理接口不被暴露', async t => {
  const box = sandbox(t), certFile = path.join(box.root, 'cert.pem'), keyFile = path.join(box.root, 'key.pem');
  const openssl = process.env.CHATAGENT_OPENSSL ?? (process.platform === 'win32' ? 'D:/Git/usr/bin/openssl.exe' : 'openssl');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const config = { certificateFile: certFile, privateKeyFile: keyFile, deviceHost: '127.0.0.1', deviceHostname: 'localhost', devicePort: 37826 };
  const options = readDeviceTlsOptions(config), cert = options.deviceTls.cert;
  assert.throws(() => readDeviceTlsOptions({ ...config, certificateFile: 'relative.pem' }), /ABSOLUTE_CONFIG_PATH_REQUIRED/);
  assert.throws(() => readDeviceTlsOptions({ ...config, devicePort: 0 }), /INVALID_DEVICE_PORT/);
  assert.throws(() => readDeviceTlsOptions({ ...config, deviceHostname: 'https://localhost' }), /INVALID_DEVICE_HOSTNAME/);
  assert.throws(() => readDeviceTlsOptions({ ...config, deviceHostname: 'wrong.example' }), /TLS_CERTIFICATE_HOST_OR_TIME_INVALID/);
  const parsed = new X509Certificate(cert);
  for (const now of [NaN, Date.parse(parsed.validFrom) - 1, Date.parse(parsed.validTo)]) assert.throws(() => readDeviceTlsOptions(config, now), /TLS_CERTIFICATE_HOST_OR_TIME_INVALID/);
  const wrongKey = path.join(box.root, 'wrong.key');
  fs.writeFileSync(wrongKey, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.throws(() => readDeviceTlsOptions({ ...config, privateKeyFile: wrongKey }), /TLS_KEY_MISMATCH/);
  // Ephemeral loopback port for this fixture; production config rejects port zero.
  const service = await startService({ dataRoot: path.join(box.root, 'service'), ...options, devicePort: 0 });
  try {
    const call = (route, { body, token, trusted = true } = {}) => new Promise((resolve, reject) => {
      const req = https.request(service.deviceUrl + route, { ...(trusted ? { ca: cert } : {}), method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)), encrypted: res.socket?.encrypted }));
      }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    await assert.rejects(call('/v1/bootstrap', { trusted: false }), /self-signed|certificate/);
    assert.equal((await call('/v1/bootstrap')).status, 401);
    const boot = await (await fetch(service.url + '/v1/bootstrap')).json();
    const invitation = await (await fetch(service.url + '/v1/pairing/invitations', { method: 'POST', headers: { 'X-Chatagent-Token': boot.token, 'Content-Type': 'application/json' }, body: '{}' })).json();
    const token = randomBytes(32).toString('hex');
    const claim = await call('/v1/pairing/claim', { body: { credential: invitation.credential, deviceToken: token, name: 'TLS合成手机' } });
    assert.equal(claim.status, 200);
    const result = await call('/v1/bootstrap', { token }); assert.equal(result.status, 200); assert.equal(result.body.token, undefined);
    assert.equal((await call('/v1/backups', { body: {}, token })).status, 403);
    assert.equal((await call('/devices', { token })).status, 403);
    assert.equal((await call('/v1/timeline', { token })).status, 200);
    for(const route of ['/v1/workspace','/v1/memory','/v1/import/records','/v1/export','/settings','/plugins','/plugins.js'])assert.equal((await call(route,{token})).status,403);
    for(const route of ['/v1/import/preview','/v1/import/apply','/v1/memory/import/preview','/v1/memory/import/apply'])assert.equal((await call(route,{token,body:{}})).status,403);
  } finally { await service.close(); }
});

test('拒绝公网、局域网明文以及无TLS的Tailscale监听配置', async t => {
  const box = sandbox(t);
  for (const deviceHost of ['0.0.0.0', '192.168.1.2', '100.64.1.2', '::']) {
    await assert.rejects(startService({ dataRoot: path.join(box.root, 'unused'), devicePort: 0, deviceHost }), /PRIVATE_TLS_LISTENER_REQUIRED/);
  }
  assert.equal(fs.existsSync(path.join(box.root, 'unused')), false);
});
