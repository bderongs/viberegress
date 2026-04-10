import assert from 'assert';
import { buildDiscoveryStateFingerprint, buildIntentSignature, evaluateJourneyDepth } from './stagehand.js';

function run(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok: ${label}`);
  } catch (e) {
    console.error(`  FAIL: ${label}`);
    throw e;
  }
}

console.log('stagehand discovery quality tests');

run('fingerprint is stable across casing and spacing noise', () => {
  const a = buildDiscoveryStateFingerprint({
    url: 'https://www.example.com/login/',
    title: '  Me Connecter ',
    summary: 'Login page',
    headingSignals: ['Me connecter', 'Adresse Email'],
    primaryActions: ['Recevoir un lien de connexion', 'Inscris-toi'],
    hasMeaningfulForm: true,
    requireAuth: true,
  });
  const b = buildDiscoveryStateFingerprint({
    url: 'https://example.com/login',
    title: 'me connecter',
    summary: 'Other summary text',
    headingSignals: ['  me connecter  ', 'adresse email'],
    primaryActions: ['recevoir un lien de connexion', 'inscris-toi'],
    hasMeaningfulForm: true,
    requireAuth: true,
  });
  assert.strictEqual(a, b);
});

run('intent signature keeps section/action distinctions', () => {
  const hero = buildIntentSignature({
    label: 'Passe le test - gratuit',
    actionInstruction: 'click button Passe le test - gratuit at [0-211]',
    sourceSection: 'hero',
  });
  const body = buildIntentSignature({
    label: 'Passe le test - gratuit',
    actionInstruction: 'click button Passe le test - gratuit at [0-357]',
    sourceSection: 'body',
  });
  assert.notStrictEqual(hero, body);
});

run('same-url fingerprint change counts as state change', () => {
  const base = buildDiscoveryStateFingerprint({
    url: 'https://example.com',
    title: 'Landing page',
    summary: 'Home',
    headingSignals: ['Landing page'],
    primaryActions: ['Se connecter', 'Passe le test'],
    hasMeaningfulForm: false,
    requireAuth: false,
  });
  const first = buildDiscoveryStateFingerprint({
    url: 'https://example.com',
    title: 'Landing page',
    summary: 'Home',
    headingSignals: ['Landing page'],
    primaryActions: ['Se connecter', 'Passe le test'],
    hasMeaningfulForm: false,
    requireAuth: false,
  });
  const final = buildDiscoveryStateFingerprint({
    url: 'https://example.com',
    title: 'Me connecter',
    summary: 'Auth gate',
    headingSignals: ['Me connecter'],
    primaryActions: ['Recevoir un lien de connexion'],
    hasMeaningfulForm: true,
    requireAuth: true,
  });

  const depth = evaluateJourneyDepth({
    strictness: 'medium',
    baseUrl: 'https://example.com',
    firstHopUrl: 'https://example.com',
    finalUrl: 'https://example.com',
    baseFingerprint: base,
    firstHopFingerprint: first,
    finalFingerprint: final,
    hopTraces: [{ actionInstruction: 'click Se connecter' }],
    finalObserved: {
      title: 'Me connecter',
      summary: 'Enter your email to continue',
      headingSignals: ['Me connecter'],
      primaryActions: ['Recevoir un lien de connexion'],
      requireAuth: true,
    },
    intentLabel: 'Se connecter',
  });

  assert.strictEqual(depth.stateChanged, true);
  assert.strictEqual(depth.samePageLoop, false);
  assert.strictEqual(depth.weakReason, undefined);
});

console.log('All stagehand discovery quality tests passed.');
process.exit(0);
