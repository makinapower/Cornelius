import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import test from 'node:test';
import { announceSatellites } from '../server/discovery.js';
import { SATELLITE_PROTOCOL } from '../server/satellites.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(signal: NodeJS.Signals) {
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

test('macOS : l’annonce passe par mDNSResponder (dns-sd), sans ouvrir le port 5353', async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const child = new FakeChild();
  const spawnProcess = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    return child;
  }) as unknown as typeof spawn;
  const errors: unknown[] = [];
  const unannounce = announceSatellites({
    port: 3443,
    keyFingerprint: 'abc',
    platform: 'darwin',
    spawnProcess,
    onError: (error) => errors.push(error),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, '/usr/bin/dns-sd');
  assert.deepEqual(calls[0]!.args.slice(2), [
    '_cornelius._tcp',
    'local',
    '3443',
    'path=/satellite',
    'protocol=' + SATELLITE_PROTOCOL,
    'key=abc',
  ]);
  await unannounce();
  assert.equal(child.signalCode, 'SIGTERM');
  assert.deepEqual(errors, [], 'un arrêt demandé n’est pas une erreur');
});

test('macOS : un arrêt inattendu de dns-sd est signalé', () => {
  const child = new FakeChild();
  const errors: unknown[] = [];
  announceSatellites({
    port: 3443,
    keyFingerprint: null,
    platform: 'darwin',
    spawnProcess: (() => child) as unknown as typeof spawn,
    onError: (error) => errors.push(error),
  });
  child.emit('exit', 1, null);
  assert.equal(errors.length, 1);
});
