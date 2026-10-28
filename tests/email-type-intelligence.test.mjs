import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import { domainToUnicode } from 'node:url';

const originalReadFileSync = fs.readFileSync.bind(fs);
const bundledReads = new Map();
const deniedEgress = [];
const isBundledPath = value => /config[\\/]email-intelligence[\\/](?:disposable-domains\.txt|metadata\.json)$/i.test(String(value));
fs.readFileSync = function guardedReadFileSync(file, ...args) {
  if (isBundledPath(file)) bundledReads.set(String(file), (bundledReads.get(String(file)) || 0) + 1);
  return originalReadFileSync(file, ...args);
};
syncBuiltinESMExports();

const deny = name => (...args) => {
  deniedEgress.push(name);
  throw new Error(`Unexpected transport call: ${name}`);
};
globalThis.fetch = deny('fetch');
net.createConnection = deny('net.createConnection');
dns.promises.lookup = deny('dns.lookup');
dns.promises.resolve = deny('dns.resolve');
dns.promises.resolveMx = deny('dns.resolveMx');
http.request = deny('http.request');
http.get = deny('http.get');
https.request = deny('https.request');
https.get = deny('https.get');
tls.connect = deny('tls.connect');
syncBuiltinESMExports();

const module = await import('../pipeline/email-type-intelligence.js');
const { classifyEmailType, getEmailTypeDatasetStatus, createEmailTypeIntelligenceForTesting } = module;
const dataPath = new URL('../config/email-intelligence/disposable-domains.txt', import.meta.url);
const metadataPath = new URL('../config/email-intelligence/metadata.json', import.meta.url);
const datasetBytes = originalReadFileSync(dataPath);
const metadata = JSON.parse(originalReadFileSync(metadataPath, 'utf8'));

test('validates the pinned snapshot and loads its bytes once per process', () => {
  assert.deepEqual(getEmailTypeDatasetStatus(), {
    available: true,
    source: 'local_disposable_dataset',
    dataset_commit: '3ebb7fef055e3757dfc9bb46b1297ee2b0d11fe7',
    dataset_sha256: 'ba19d6735fc2224db58d3eaa9bb294de43437a488133c4271fb07d0ad4436fc7',
  });
  assert.equal(classifyEmailType({ domain: '0-00.usa.cc', localPart: 'person' }).is_disposable, true);
  assert.equal(classifyEmailType({ domain: 'person.0-00.usa.cc', localPart: 'person' }).classification_evidence.matched_domain, '0-00.usa.cc');
  assert.equal(bundledReads.size, 2);
  assert.deepEqual([...bundledReads.values()], [1, 1]);
});

test('matches real closest parent domains and returns the actual matched domain', () => {
  const result = classifyEmailType({ domain: 'sub.mailinator.com', localPart: 'user' });
  assert.equal(result.is_disposable, true);
  assert.equal(result.classification_evidence.match, true);
  assert.equal(result.classification_evidence.matched_domain, 'mailinator.com');
});

test('normal list hits outside the former embedded set are classified offline', () => {
  const result = classifyEmailType({ domain: '0-00.usa.cc', localPart: 'person' });
  assert.equal(result.is_disposable, true);
  assert.equal(result.classification_evidence.dataset_available, true);
  assert.equal(result.classification_evidence.source, 'local_disposable_dataset');
});

test('ordinary providers and relay aliases are not called disposable by this normal snapshot', () => {
  for (const domain of [
    'gmail.com', 'googlemail.com', 'outlook.com', 'yahoo.com', 'proton.me',
    'simplelogin.com', 'addy.io', 'duck.com', 'relay.firefox.com',
    'privaterelay.appleid.com', 'burnermail.io',
  ]) {
    const result = classifyEmailType({ domain, localPart: 'person' });
    assert.equal(result.is_disposable, false, domain);
    assert.equal(result.classification_evidence.match, false, domain);
  }
});

test('free-provider and role signals stay independent and preserve local-part semantics', () => {
  const freeRole = classifyEmailType({ domain: 'GMAIL.COM', localPart: 'Sales', rolePrefixes: ['sales'] });
  assert.equal(freeRole.is_free_provider, true);
  assert.equal(freeRole.is_role_account, true);
  assert.equal(freeRole.is_disposable, false);

  const tagged = classifyEmailType({ domain: 'gmail.com', localPart: 'sales+tag', rolePrefixes: ['sales'] });
  assert.equal(tagged.is_role_account, false);
  assert.equal(tagged.is_free_provider, true);
  assert.equal(tagged.is_disposable, false);
});

test('domain normalization handles case and IDN while refusing URL-like or malformed domains', () => {
  const ascii = classifyEmailType({ domain: 'XN--4DBCEIG1B7E.COM', localPart: 'p' });
  const unicode = classifyEmailType({ domain: domainToUnicode('xn--4dbceig1b7e.com'), localPart: 'p' });
  assert.equal(ascii.is_disposable, true);
  assert.equal(unicode.is_disposable, true);
  assert.equal(unicode.classification_evidence.matched_domain, 'xn--4dbceig1b7e.com');

  for (const domain of ['https://mailinator.com', 'mailinator.com/path', 'mailinator.com%2f', 'mailinator.com?x=1', 'bad..mailinator.com', ' mailinator.com', 'mailinator.com.']) {
    const result = classifyEmailType({ domain, localPart: 'p' });
    assert.equal(result.is_disposable, null, domain);
    assert.equal(result.classification_evidence.match, null, domain);
    assert.equal(result.classification_evidence.dataset_available, true, domain);
  }
});

test('numeric host spellings that WHATWG parsing rewrites remain unknown', () => {
  for (const domain of ['127.1', '0x7f000001', '0177.0.0.1', '2130706433', '０１７７.０.０.１', '127.0.0.1']) {
    const result = classifyEmailType({ domain, localPart: 'p' });
    assert.equal(result.is_disposable, null, domain);
    assert.equal(result.classification_evidence.match, null, domain);
    assert.equal(result.classification_evidence.matched_domain, null, domain);
    assert.equal(result.classification_evidence.dataset_available, true, domain);
  }

  assert.equal(classifyEmailType({ domain: 'MAILINATOR.COM', localPart: 'p' }).is_disposable, true);
  assert.equal(classifyEmailType({ domain: domainToUnicode('xn--4dbceig1b7e.com'), localPart: 'p' }).is_disposable, true);
});

test('missing, damaged, or mismatched fixture data stays explicitly unknown', () => {
  const missing = createEmailTypeIntelligenceForTesting({ metadata });
  const damagedBytes = Buffer.from(datasetBytes);
  damagedBytes[0] ^= 1;
  const damaged = createEmailTypeIntelligenceForTesting({ datasetBytes: damagedBytes, metadata });
  const mismatched = createEmailTypeIntelligenceForTesting({ datasetBytes, metadata: { ...metadata, nonempty_unique_domain_count: 1 } });

  for (const fixture of [missing, damaged, mismatched]) {
    assert.equal(fixture.getEmailTypeDatasetStatus().available, false);
    const result = fixture.classifyEmailType({ domain: 'gmail.com', localPart: 'info', rolePrefixes: ['info'] });
    assert.equal(result.is_disposable, null);
    assert.equal(result.is_free_provider, true);
    assert.equal(result.is_role_account, true);
    assert.equal(result.classification_evidence.dataset_available, false);
    assert.equal(result.classification_evidence.match, null);
    assert.equal(result.classification_evidence.matched_domain, null);
  }
});

test('classifier and its module import make no transport or DNS calls', () => {
  classifyEmailType({ domain: 'mailinator.com', localPart: 'x' });
  getEmailTypeDatasetStatus();
  assert.deepEqual(deniedEgress, []);
});
