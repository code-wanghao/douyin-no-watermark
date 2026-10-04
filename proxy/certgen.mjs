/**
 * 极简 X.509 证书生成器（零依赖，纯 Node）
 *
 * 生成两样东西：
 *   ca.pem / ca.cer  —— 本地根证书（需要装进系统信任区，才能解密抖音的 HTTPS）
 *   leaf.pem + leaf-key.pem —— 服务器证书，SAN 覆盖抖音相关域名
 *
 * Node 自带 crypto 只能"读"X.509，不能"写"，所以这里手写了一个最小 DER 编码器。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* ============================ DER 编码器 ============================ */

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const setOf = (...items) => tlv(0x31, Buffer.concat(items));
const group = (n, content) => tlv(0xa0 + n, content);
const nul = () => tlv(0x05, Buffer.alloc(0));
const octet = (b) => tlv(0x04, b);
const boolOf = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const bitStr = (b, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const dnsName = (s) => tlv(0x82, Buffer.from(s, 'ascii'));

function intOf(input) {
  let b = Buffer.from(input);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oidOf(str) {
  const parts = str.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [];
    let v = part;
    do {
      stack.unshift(v & 0x7f);
      v >>>= 7;
    } while (v > 0);
    for (let i = 0; i < stack.length - 1; i++) stack[i] |= 0x80;
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const s = p(date.getUTCFullYear() % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate())
    + p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

function nameOf(cn) {
  return seq(setOf(seq(oidOf('2.5.4.3'), utf8(cn))));
}

function extension(oidStr, critical, valueDer) {
  const parts = [oidOf(oidStr)];
  if (critical) parts.push(boolOf(true));
  parts.push(octet(valueDer));
  return seq(...parts);
}

const OID = {
  sha256Rsa: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

function pemEncode(der, label) {
  const lines = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

/* ============================ 证书组装 ============================ */

function buildCertificate({ subject, issuer, subjectPublicKey, serial, notBefore, notAfter, extensions, signerKey }) {
  const tbs = seq(
    group(0, intOf(Buffer.from([2]))),                       // version: v3
    intOf(serial),
    seq(oidOf(OID.sha256Rsa), nul()),                       // signature algorithm
    issuer,
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    subjectPublicKey,                                       // SubjectPublicKeyInfo (already DER)
    group(3, seq(...extensions)),
  );
  const signature = crypto.sign('sha256', tbs, signerKey);
  return seq(tbs, seq(oidOf(OID.sha256Rsa), nul()), bitStr(signature));
}

export const SAN_HOSTS = [
  'douyin.com',
  '*.douyin.com',
  '*.douyinpic.com',
  '*.douyinvod.com',
  '*.douyinstatic.com',
  '*.byteimg.com',
  '*.bytedance.com',
  '*.iesdouyin.com',
  '*.snssdk.com',
];

export function generateCerts(outDir, { commonName = 'Douyin Local Capture CA' } = {}) {
  fs.mkdirSync(outDir, { recursive: true });

  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const caNotAfter = new Date(now.getTime() + 5 * 365 * 24 * 3600 * 1000);
  const leafNotAfter = new Date(now.getTime() + 3 * 365 * 24 * 3600 * 1000);

  // ---- 根证书 ----
  const caKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const caName = nameOf(commonName);
  const caDer = buildCertificate({
    subject: caName,
    issuer: caName,
    subjectPublicKey: caKeys.publicKey.export({ type: 'spki', format: 'der' }),
    serial: crypto.randomBytes(16),
    notBefore,
    notAfter: caNotAfter,
    extensions: [
      extension(OID.basicConstraints, true, seq(boolOf(true))),
      extension(OID.keyUsage, true, bitStr(Buffer.from([0x06]), 1)), // keyCertSign + cRLSign
    ],
    signerKey: caKeys.privateKey,
  });

  // ---- 服务器证书（由根证书签发）----
  const leafKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const leafDer = buildCertificate({
    subject: nameOf('douyin-local-capture'),
    issuer: caName,
    subjectPublicKey: leafKeys.publicKey.export({ type: 'spki', format: 'der' }),
    serial: crypto.randomBytes(16),
    notBefore,
    notAfter: leafNotAfter,
    extensions: [
      extension(OID.basicConstraints, true, seq()),
      extension(OID.keyUsage, true, bitStr(Buffer.from([0xa0]), 5)), // digitalSignature + keyEncipherment
      extension(OID.extKeyUsage, false, seq(oidOf(OID.serverAuth))),
      extension(OID.subjectAltName, false, seq(...SAN_HOSTS.map(dnsName))),
    ],
    signerKey: caKeys.privateKey,
  });

  const files = {
    caPem: path.join(outDir, 'ca.pem'),
    caCer: path.join(outDir, 'ca.cer'),
    leafPem: path.join(outDir, 'leaf.pem'),
    leafKey: path.join(outDir, 'leaf-key.pem'),
  };

  fs.writeFileSync(files.caPem, pemEncode(caDer, 'CERTIFICATE'), 'utf8');
  fs.writeFileSync(files.caCer, caDer);                       // DER，供导入信任区
  fs.writeFileSync(files.leafPem, pemEncode(leafDer, 'CERTIFICATE'), 'utf8');
  fs.writeFileSync(files.leafKey, pemEncode(
    leafKeys.privateKey.export({ type: 'pkcs8', format: 'der' }), 'PRIVATE KEY',
  ), 'utf8');

  const thumbprint = crypto.createHash('sha1').update(caDer).digest('hex').toUpperCase();
  return { files, thumbprint, caDer };
}

export function loadCerts(dir) {
  const caPem = fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8');
  const leafPem = fs.readFileSync(path.join(dir, 'leaf.pem'), 'utf8');
  const leafKey = fs.readFileSync(path.join(dir, 'leaf-key.pem'), 'utf8');
  const caDer = fs.readFileSync(path.join(dir, 'ca.cer'));
  const thumbprint = crypto.createHash('sha1').update(caDer).digest('hex').toUpperCase();
  return { caPem, leafPem, leafKey, caDer, thumbprint };
}

/* ============================ 自检 ============================ */

function selfTest(dir) {
  const { files, thumbprint } = generateCerts(dir);
  const ca = new crypto.X509Certificate(fs.readFileSync(files.caPem));
  const leaf = new crypto.X509Certificate(fs.readFileSync(files.leafPem));

  const out = [];
  out.push(`CA  subject : ${ca.subject.replace(/\n/g, ' ')}`);
  out.push(`CA  有效期 : ${ca.validFrom} -> ${ca.validTo}`);
  out.push(`CA  指纹   : ${thumbprint}`);
  out.push(`叶  subject: ${leaf.subject.replace(/\n/g, ' ')}`);
  out.push(`叶  签发者 : ${leaf.issuer.replace(/\n/g, ' ')}`);
  out.push(`链校验     : ${leaf.verify(ca.publicKey) ? 'OK' : '失败'}`);
  const hosts = ['www.douyin.com', 'www-hj.douyin.com', 'p3-pc-sign.douyinpic.com', 'www.example.com'];
  for (const h of hosts) out.push(`  checkHost ${h.padEnd(28)} -> ${leaf.checkHost(h) ? '匹配' : '不匹配'}`);
  return out.join('\n');
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  const dir = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'certs');
  process.stdout.write(selfTest(dir) + '\n');
}
