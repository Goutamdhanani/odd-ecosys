import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySmtpSendError } from '../pipeline/sending-engine.js';

test('SMTP send failures receive explicit, truthful categories and response evidence', () => {
  const cases = [
    [{ code: 'SMTP_NOT_CONFIGURED' }, 'configuration', null, null],
    [{ code: 'EAUTH', command: 'AUTH', responseCode: 535, response: '535 5.7.8 Authentication failed' }, 'authentication', 535, '5.7.8'],
    [{ smtpNotAccepted: true, command: 'RCPT TO' }, 'recipient_not_accepted', null, null],
    [{ responseCode: 451, command: 'DATA', response: '451 4.7.1 Try again later' }, 'smtp_temporary_rejection', 451, '4.7.1'],
    [{ responseCode: 554, command: 'DATA', response: '554 5.6.0 Message rejected' }, 'smtp_permanent_rejection', 554, '5.6.0'],
    [{ code: 'ETIMEDOUT', command: 'CONN' }, 'network_timeout', null, null],
    [{ code: 'ECONNRESET', command: 'DATA' }, 'network_error', null, null],
    [{ message: 'unclassified transport failure' }, 'unknown', null, null],
  ];

  for (const [error, category, responseCode, enhancedStatusCode] of cases) {
    assert.deepEqual(classifySmtpSendError(error), {
      category,
      responseCode,
      enhancedStatusCode,
      command: error.command || null,
    });
  }
});
