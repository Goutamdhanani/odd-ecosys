import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { probeSmtp } from '../pipeline/email-verifier.js';
process.env.ODD_VERIFIER_FROM_EMAIL = 'probe@fixture.test';
process.env.ODD_VERIFIER_EHLO_DOMAIN = 'verifier.fixture.test';

test('SMTP refuses private, mixed, reserved and injected destinations before connecting', async () => {
  let connections = 0;
  const connectImpl = () => { connections++; throw Object.assign(new Error('must not connect'), { code: 'TEST_CONNECTED' }); };
  for (const host of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '::1', '::ffff:127.0.0.1', '192.0.2.1', 'localhost']) {
    const result = await probeSmtp(host, 'person@example.test', { connectImpl, resolveAddressesImpl: async () => [{ address: '127.0.0.1', family: 4 }] });
    assert.equal(result.reason, 'smtp_destination_blocked', host);
    assert.equal(result.is_deliverable, null);
  }
  const mixed = await probeSmtp('mx.example.test', 'person@example.test', {
    connectImpl,
    resolveAddressesImpl: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.2', family: 4 }],
  });
  assert.equal(mixed.reason, 'smtp_destination_blocked');
  for (const [toEmail, fromEmail] of [['person@example.test\r\nDATA', 'sender@example.test'], ['person@example.test', 'sender@example.test\r\nDATA']]) {
    const result = await probeSmtp('8.8.8.8', toEmail, { fromEmail, connectImpl });
    assert.equal(result.reason, 'smtp_invalid_envelope');
  }
  assert.equal(connections, 0);
});

test('SMTP resolves once and pins the validated public address instead of looking it up at connect', async () => {
  let lookups = 0;
  let destination;
  const result = await probeSmtp('mx.example.test', 'person@example.test', {
    resolveAddressesImpl: async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }]; },
    connectImpl: (port, host, family) => {
      destination = { port, host, family };
      throw Object.assign(new Error('synthetic refusal'), { code: 'ECONNREFUSED' });
    },
  });
  assert.deepEqual(destination, { port: 25, host: '8.8.8.8', family: 4 });
  assert.equal(lookups, 1);
  assert.equal(result.reason, 'smtp_connection_failed:ECONNREFUSED');
});

test('SMTP total deadline includes unresolved DNS and prevents a late connection', async () => {
  let connected = false;
  const result = await probeSmtp('mx.example.test', 'person@example.test', {
    timeoutMs: 30,
    resolveAddressesImpl: async () => { await new Promise(resolve => setTimeout(resolve, 100)); return [{ address: '8.8.8.8', family: 4 }]; },
    connectImpl: () => { connected = true; throw new Error('late connection'); },
  });
  assert.equal(result.stage, 'resolve');
  assert.equal(result.reason, 'smtp_timeout:resolve');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(connected, false);
});

test('SMTP total deadline stops slow dripping responses even while the socket remains active', async () => {
  const sockets = new Set();
  const sink = net.createServer(socket => {
    sockets.add(socket);
    const timer = setInterval(() => socket.write('2'), 10);
    // Bound this fixture even against the vulnerable implementation.
    const close = setTimeout(() => socket.destroy(), 350);
    socket.on('error', () => {});
    socket.on('close', () => { clearInterval(timer); clearTimeout(close); sockets.delete(socket); });
  });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  try {
    const result = await probeSmtp('127.0.0.1', 'person@example.test', {
      port: sink.address().port, timeoutMs: 80, addressPolicy: address => address === '127.0.0.1',
    });
    assert.equal(result.reason, 'smtp_timeout:greeting');
    assert.equal(result.is_deliverable, null);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => sink.close(resolve));
  }
});

test('SMTP flushes QUIT and destroys its socket when an accepting peer withholds FIN', async () => {
  let client;
  const peers = new Set();
  const commands = [];
  const sink = net.createServer({ allowHalfOpen: true }, peer => {
    peers.add(peer);
    peer.on('error', () => {});
    peer.on('close', () => peers.delete(peer));
    peer.write('220 sink\r\n');
    let input = '';
    peer.on('data', data => {
      input += data.toString('ascii');
      let end;
      while ((end = input.indexOf('\r\n')) >= 0) {
        const command = input.slice(0, end); input = input.slice(end + 2); commands.push(command);
        if (command.startsWith('EHLO') || command.startsWith('MAIL') || command.startsWith('RCPT')) peer.write('250 accepted\r\n');
      }
    });
  });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  try {
    const result = await probeSmtp('127.0.0.1', 'person@example.test', {
      port: sink.address().port, timeoutMs: 100, addressPolicy: ip => ip === '127.0.0.1',
      connectImpl: (port, host) => { client = net.createConnection({ port, host }); return client; },
    });
    assert.equal(result.recipient_accepted, true);
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.equal(client.destroyed, true);
    assert.ok(commands.includes('QUIT'));
    assert.equal(commands.some(command => command.startsWith('DATA')), false);
  } finally {
    client?.destroy();
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => sink.close(resolve));
  }
});

test('release network guard blocks numeric-string ports and literal IPs before the socket implementation', () => {
  const guardUrl = new URL('./support/loopback-only.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    let called = 0;
    net.Socket.prototype.connect = function() { called++; return this; };
    await import(${JSON.stringify(guardUrl)});
    for (const port of [25, '25', ' 25 ', '+25', '0x19', '25e0']) {
      assert.throws(() => new net.Socket().connect(port, '203.0.113.1'), /External network disabled/);
    }
    assert.throws(() => new net.Socket().connect({ port: 25, host: '2001:db8::1' }), /External network disabled/);
    assert.equal(called, 0);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
