import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, assertPublicUrl, SsrfError } from '../src/ssrf.js';

test('isPrivateIp: classifies loopback, private and link-local IPv4', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.0.0.5'), true);
  assert.equal(isPrivateIp('172.16.0.1'), true);
  assert.equal(isPrivateIp('172.31.255.255'), true);
  assert.equal(isPrivateIp('172.32.0.1'), false); // just outside the 172.16/12 block
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('169.254.1.1'), true);
  assert.equal(isPrivateIp('0.0.0.0'), true);
});

test('isPrivateIp: a normal public IPv4 is not private', () => {
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('1.1.1.1'), false);
});

test('isPrivateIp: classifies IPv6 loopback, unique-local and link-local', () => {
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
  assert.equal(isPrivateIp('fd00::1'), true);
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true); // IPv4-mapped loopback
  assert.equal(isPrivateIp('2001:4860:4860::8888'), false); // Google DNS, public
});

test('assertPublicUrl: refuses non-http(s) schemes', async () => {
  await assert.rejects(() => assertPublicUrl('ftp://example.com/x'), SsrfError);
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), SsrfError);
});

test('assertPublicUrl: refuses a literal private IP without a DNS lookup', async () => {
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1:3003/api/share/x'), SsrfError);
  await assert.rejects(() => assertPublicUrl('http://192.168.1.1/x'), SsrfError);
});

test('assertPublicUrl: allowPrivate lets a private literal IP through', async () => {
  const url = await assertPublicUrl('http://127.0.0.1:3003/api/share/x', true);
  assert.equal(url.hostname, '127.0.0.1');
});
