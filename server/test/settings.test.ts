import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { applySettingsUpdate, getSettings, publicSettings, tfnswKey } from '../src/settings.js';

const SECRET = 'sekrit-tfnsw-key-123';

test('settings: the TfNSW key is stored but never appears in the public (GET) settings', () => {
  delete process.env.TFNSW_API_KEY;
  const db = createDb(':memory:');
  const { keyChanged } = applySettingsUpdate(db, { tfnswApiKey: SECRET });
  assert.equal(keyChanged, true);
  assert.equal(tfnswKey(db), SECRET);
  const out = publicSettings(getSettings(db));
  assert.ok(!JSON.stringify(out).includes(SECRET), 'key leaked into GET output');
  assert.ok(!('tfnswApiKey' in out));
  assert.equal(out.tfnswApiKeySet, true);
  assert.equal(out.tfnswApiKeyFromEnv, false);
});

test('settings: PUT keeps the key unless a non-empty one is sent, and clears it explicitly', () => {
  delete process.env.TFNSW_API_KEY;
  const db = createDb(':memory:');
  applySettingsUpdate(db, { tfnswApiKey: SECRET });
  assert.equal(applySettingsUpdate(db, { allowSignup: true, tfnswApiKey: '' }).keyChanged, false);
  applySettingsUpdate(db, { tfnswApiKeySet: false }); // echoing the GET shape back must not clear it
  assert.equal(tfnswKey(db), SECRET);
  applySettingsUpdate(db, { clearTfnswApiKey: true });
  assert.equal(tfnswKey(db), '');
  assert.equal(publicSettings(getSettings(db)).tfnswApiKeySet, false);
});

test('settings: env TFNSW_API_KEY wins and is reported as such, still never returned', () => {
  process.env.TFNSW_API_KEY = 'from-env-key';
  try {
    const db = createDb(':memory:');
    applySettingsUpdate(db, { tfnswApiKey: SECRET });
    assert.equal(tfnswKey(db), 'from-env-key');
    const out = publicSettings(getSettings(db));
    assert.equal(out.tfnswApiKeyFromEnv, true);
    assert.ok(!JSON.stringify(out).includes('from-env-key'));
  } finally {
    delete process.env.TFNSW_API_KEY;
  }
});
