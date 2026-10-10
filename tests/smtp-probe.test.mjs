import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { probeSmtp, verifyEmail } from '../pipeline/email-verifier.js';

async function runWithSink({ greeting = '220 synthetic ESMTP\r\n', onCommand, timeoutMs = 500 } = {}, run) {
  const commands = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (greeting) socket.write(greeting);
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString('ascii');
      let end;
      while ((end = input.indexOf('\r\n')) >= 0) {
        const command = input.slice(0, end);
        input = input.slice(end + 2);
        commands.push(command);
        onCommand?.(socket, command, commands);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const result = await run(server.address().port);
    await new Promise(resolve => setTimeout(resolve, 5));
    return { result, commands };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

async function probeAgainstSink(options = {}) {
  return runWithSink(options, port => probeSmtp('127.0.0.1', 'Person@example.test', { port, timeoutMs: options.timeoutMs ?? 500 }));
}

test('F027: waits for complete multiline EHLO before sending the next command', async () => {
  let ehloComplete = false;
  let mailSentBeforeEhloComplete = false;
  const { result, commands } = await probeAgainstSink({
    onCommand(socket, command) {
      if (command.startsWith('EHLO ')) {
        socket.write('250-synthetic sink\r\n250-PIPELINING\r\n250 ');
        setTimeout(() => {
          ehloComplete = true;
          socket.write('SIZE 2048\r\n');
        }, 10);
      } else if (command.startsWith('MAIL FROM:')) {
        if (!ehloComplete) mailSentBeforeEhloComplete = true;
        socket.write('250 2.1.0 sender accepted\r\n');
      } else if (command.startsWith('RCPT TO:')) {
        socket.write('250 2.1.5 recipient accepted\r\n');
      }
    },
  });

  assert.deepEqual(commands.map(command => command.split(' ')[0]), ['EHLO', 'MAIL', 'RCPT', 'QUIT']);
  assert.equal(mailSentBeforeEhloComplete, false);
  assert.equal(result.stage, 'rcpt_to');
  assert.equal(result.code, 250);
  assert.equal(result.response, '2.1.5 recipient accepted');
  assert.equal(result.recipient_accepted, true);
  assert.equal(result.is_deliverable, null);
  assert.equal(result.is_catch_all, null);
  assert.equal(result.reason, 'smtp_rcpt_accepted_not_mailbox_proof');
});

test('F027: only an explicit 5.1.1 recipient response is a negative mailbox result', async () => {
  const response = async text => probeAgainstSink({
    onCommand(socket, command) {
      if (command.startsWith('EHLO ')) socket.write('250 sink\r\n');
      else if (command.startsWith('MAIL FROM:')) socket.write('250 sender ok\r\n');
      else if (command.startsWith('RCPT TO:')) socket.write(`${text}\r\n`);
    },
  });

  const explicit = await response('550 5.1.1 recipient does not exist');
  assert.equal(explicit.result.is_deliverable, false);
  assert.equal(explicit.result.recipient_accepted, false);
  assert.equal(explicit.result.reason, 'smtp_recipient_address_rejected:5.1.1');

  const generic = await response('550 mailbox unavailable');
  assert.equal(generic.result.is_deliverable, null);
  assert.equal(generic.result.recipient_accepted, null);
  assert.equal(generic.result.reason, 'smtp_unclassified_rcpt_response:550');

  const temporary = await response('451 4.7.1 try again later');
  assert.equal(temporary.result.is_deliverable, null);
  assert.equal(temporary.result.reason, 'smtp_temporary_rcpt_response:451');
});

test('F027: disconnects and timeouts retain their SMTP stage and unknown status', async () => {
  const disconnected = await probeAgainstSink({
    onCommand(socket, command) {
      if (command.startsWith('EHLO ')) {
        socket.write('250-partial response\r\n');
        setTimeout(() => socket.end(), 5);
      }
    },
    greeting: '220 synthetic ESMTP\r\n',
  });

  assert.equal(disconnected.result.is_deliverable, null);
  assert.equal(disconnected.result.stage, 'ehlo');
  assert.equal(disconnected.result.reason, 'smtp_connection_closed:ehlo');
  assert.equal(disconnected.result.can_connect_smtp, true);

  const timeout = await probeAgainstSink({ greeting: '', timeoutMs: 60 });
  assert.equal(timeout.result.is_deliverable, null);
  assert.equal(timeout.result.stage, 'greeting');
  assert.equal(timeout.result.reason, 'smtp_timeout:greeting');
  assert.equal(timeout.result.can_connect_smtp, true);
});

test('F027: local verification keeps RCPT acceptance risky until mailbox evidence exists', async () => {
  const { result } = await runWithSink({
    onCommand(socket, command) {
      if (command.startsWith('EHLO ')) socket.write('250 synthetic sink\r\n');
      else if (command.startsWith('MAIL FROM:')) socket.write('250 sender accepted\r\n');
      else if (command.startsWith('RCPT TO:')) socket.write('250 recipient accepted\r\n');
    },
  }, port => verifyEmail('Person@mx.example', {
    isReacherAvailableImpl: async () => false,
    resolveMxImpl: async () => [{ priority: 10, exchange: 'mx.example' }],
    checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false, disifyData: null }),
    smtpProbeImpl: (_host, address) => probeSmtp('127.0.0.1', address, { port, timeoutMs: 500 }),
  }));

  assert.equal(result.verification_status, 'risky');
  assert.equal(result.checks.smtp, null);
  assert.equal(result.is_catch_all, null);
  assert.equal(result.reacher.smtp.recipient_accepted, true);
  assert.equal(result.reacher.smtp.is_deliverable, null);
  assert.ok(result.reasons.includes('deliverability_unconfirmed'));
});

test('Gmail remains recognized when local SMTP is unreachable and the reason stays evidence-based', async () => {
  const result = await verifyEmail('goutamdhanani@gmail.com', {
    isReacherAvailableImpl: async () => false,
    resolveMxImpl: async () => [{ priority: 5, exchange: 'gmail-smtp-in.l.google.com' }],
    checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false, disifyData: null }),
    smtpProbeImpl: async () => ({
      can_connect_smtp: false, is_deliverable: null, is_catch_all: null,
      stage: 'connect', reason: 'smtp_connection_failed:ECONNREFUSED',
    }),
  });

  assert.equal(result.verification_status, 'risky');
  assert.equal(result.is_free_provider, true);
  assert.equal(result.mail_server.smtp_provider, 'Google');
  assert.equal(result.mx_host, 'gmail-smtp-in.l.google.com');
  assert.equal(result.checks.smtp, null);
  assert.equal(result.general.reason, 'SMTP Connection Unavailable');
  assert.ok(!result.reasons.includes('smtp_unconfirmed_port25_blocked'));
  assert.ok(result.reasons.includes('smtp_connection_unavailable'));
});
