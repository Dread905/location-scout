import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsAuth, canRead, canEdit, SessionUser } from '../src/auth.js';

const admin: SessionUser = { id: 'admin-1', role: 'admin' };
const contributor: SessionUser = { id: 'contrib-1', role: 'contributor' };
const otherContributor: SessionUser = { id: 'contrib-2', role: 'contributor' };

test('needsAuth: private mode requires a session for every route except open ones', () => {
  assert.equal(needsAuth('GET', '/api/spots', 'private'), true);
  assert.equal(needsAuth('GET', '/api/auth/status', 'private'), false);
  assert.equal(needsAuth('POST', '/api/auth/login', 'private'), false);
  assert.equal(needsAuth('POST', '/api/spots', 'private'), true);
});

test('needsAuth: public mode leaves reads open, writes gated', () => {
  assert.equal(needsAuth('GET', '/api/spots', 'public'), false);
  assert.equal(needsAuth('HEAD', '/api/spots', 'public'), false);
  assert.equal(needsAuth('POST', '/api/spots', 'public'), true);
  assert.equal(needsAuth('PATCH', '/api/spots/abc', 'public'), true);
  assert.equal(needsAuth('DELETE', '/api/spots/abc', 'public'), true);
});

test('needsAuth: a share token is always open, but managing shares is not', () => {
  assert.equal(needsAuth('GET', '/api/share/abc123', 'private'), false);
  assert.equal(needsAuth('GET', '/api/share/abc123/photos/xyz/file', 'private'), false);
  assert.equal(needsAuth('GET', '/api/shares', 'private'), true);
  assert.equal(needsAuth('POST', '/api/shares', 'public'), true);
});

test('canRead: public and unlisted are always readable', () => {
  assert.equal(canRead('public', 'someone-else', null), true);
  assert.equal(canRead('unlisted', 'someone-else', null), true);
  assert.equal(canRead('unlisted', 'someone-else', contributor), true);
});

test('canRead: private is owner or admin only', () => {
  assert.equal(canRead('private', contributor.id, null), false);
  assert.equal(canRead('private', contributor.id, otherContributor), false);
  assert.equal(canRead('private', contributor.id, contributor), true);
  assert.equal(canRead('private', contributor.id, admin), true);
});

test('canEdit: owner or admin only, never anonymous', () => {
  assert.equal(canEdit(contributor.id, null), false);
  assert.equal(canEdit(contributor.id, otherContributor), false);
  assert.equal(canEdit(contributor.id, contributor), true);
  assert.equal(canEdit(contributor.id, admin), true);
});
