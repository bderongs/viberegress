import assert from 'assert';
import { scenarioToPublicJson, isValidShareTokenFormat } from './site-share.js';
import type { Scenario } from '../types/index.js';

const sample: Scenario = {
  id: 's1',
  name: 'Test',
  description: 'D',
  siteUrl: 'https://x.com',
  steps: [{ instruction: 'go', type: 'act' }],
  createdAt: '2025-01-01T00:00:00.000Z',
  lastStatus: 'never',
  authProfileId: 'secret-profile',
};

const pub = scenarioToPublicJson(sample);
assert.strictEqual(pub.id, 's1');
assert.strictEqual((pub as { authProfileId?: string }).authProfileId, undefined);
assert.ok(isValidShareTokenFormat('a'.repeat(43)));
assert.ok(!isValidShareTokenFormat('short'));
assert.ok(!isValidShareTokenFormat('has space'));
assert.ok(!isValidShareTokenFormat(''));

console.log('site-share.test.ts OK');
