/**
 * Unit tests for DevTools cookie table parser.
 */

import { parseCookiesFromDevTools } from './parse-devtools-cookies.js';

const chromePaste = `Name	Value	Domain	Path	Expires	Size	HttpOnly	Secure	SameSite	Priority
session	abc123	.example.com	/	Session	10	✓	✓	Lax	Medium
token	xyz789	.example.com	/	1735689600	6			None	Medium`;

const multiLineValue = `mycookie	base64-verylong
valuewithnewline	www.sparkier.io	/	Session	10		Lax		Medium`;

let passed = 0;
let failed = 0;

function ok(name: string) {
  console.log('ok', name);
  passed++;
}

function fail(name: string, e: unknown) {
  console.error('FAIL', name, e);
  failed++;
}

const r = parseCookiesFromDevTools(chromePaste);
if (r.length === 2 && r[0].name === 'session' && r[0].value === 'abc123' && r[0].domain === '.example.com') ok('Chrome TSV with header');
else fail('Chrome TSV with header', r);

const rMulti = parseCookiesFromDevTools(multiLineValue);
if (rMulti.length === 1 && rMulti[0].name === 'mycookie' && rMulti[0].value.includes('verylong') && rMulti[0].value.includes('valuewithnewline') && rMulti[0].domain === 'www.sparkier.io') ok('Value with newline');
else fail('Value with newline', rMulti);

const noHeader = 'sess\tval123\texample.com\t/';
const r2 = parseCookiesFromDevTools(noHeader);
if (r2.length === 1 && r2[0].name === 'sess' && r2[0].value === 'val123' && r2[0].domain === 'example.com') ok('No header default order');
else fail('No header default order', r2);

try {
  parseCookiesFromDevTools('');
  fail('Empty throws', 'expected throw');
} catch {
  ok('Empty throws');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
