import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';

export function readDeviceTlsOptions(config, now = Date.now()) {
  for (const name of ['certificateFile', 'privateKeyFile']) if (!path.isAbsolute(config[name] ?? '')) throw Error('ABSOLUTE_CONFIG_PATH_REQUIRED');
  if (!Number.isInteger(config.devicePort) || config.devicePort < 1 || config.devicePort > 65535) throw Error('INVALID_DEVICE_PORT');
  if (typeof config.deviceHostname !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(config.deviceHostname)) throw Error('INVALID_DEVICE_HOSTNAME');
  const cert = fs.readFileSync(config.certificateFile), key = fs.readFileSync(config.privateKeyFile), certificate = new X509Certificate(cert);
  if (!Number.isFinite(now) || now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo) || !certificate.checkHost(config.deviceHostname)) throw Error('TLS_CERTIFICATE_HOST_OR_TIME_INVALID');
  if (!certificate.publicKey.equals(createPublicKey(createPrivateKey(key)))) throw Error('TLS_KEY_MISMATCH');
  return { devicePort: config.devicePort, deviceHost: config.deviceHost, deviceHostname: config.deviceHostname, deviceTls: { key, cert } };
}
