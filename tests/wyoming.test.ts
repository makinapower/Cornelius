import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Server } from 'node:net';
import test, { type TestContext } from 'node:test';
import type { ConnectServerEvent } from 'openai/resources/live/sideband';
import { createLocalGateway, localConversationConfig } from '../server/live/local-gateway.js';
import {
  encodeWyomingEvent,
  wyomingAddress,
  WyomingReader,
  wyomingSynthesize,
  wyomingTranscribe,
  type WyomingEvent,
} from '../server/live/wyoming.js';

/** Faux service Wyoming : lit les événements reçus, répond avec `reply`. */
async function fakeService(
  t: TestContext,
  reply: (
    events: WyomingEvent[],
    send: (event: Parameters<typeof encodeWyomingEvent>[0]) => void,
  ) => void,
) {
  const received: WyomingEvent[][] = [];
  const server: Server = createServer((socket) => {
    const reader = new WyomingReader();
    const events: WyomingEvent[] = [];
    received.push(events);
    socket.on('data', (chunk) => {
      for (const event of reader.push(chunk)) {
        events.push(event);
        reply(events, (answer) => socket.write(encodeWyomingEvent(answer)));
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { address: { host: '127.0.0.1', port }, url: 'tcp://127.0.0.1:' + port, received };
}

test('adresse Wyoming : tcp:// ou wyoming://, sinon API HTTP', () => {
  assert.deepEqual(wyomingAddress('tcp://192.168.1.20:10300'), {
    host: '192.168.1.20',
    port: 10300,
  });
  assert.deepEqual(wyomingAddress('wyoming://homeassistant.local:10200/'), {
    host: 'homeassistant.local',
    port: 10200,
  });
  assert.equal(wyomingAddress('http://127.0.0.1:8001/v1'), null);
  assert.equal(wyomingAddress('tcp://hote'), null);
  assert.equal(wyomingAddress('tcp://hote:99999'), null);
});

test('lecture : en-tête, données séparées ou intégrées et charge, en morceaux quelconques', () => {
  const bytes = Buffer.concat([
    encodeWyomingEvent({ type: 'transcript', data: { text: 'Bonjour à tous' } }),
    Buffer.from(JSON.stringify({ type: 'audio-start', data: { rate: 22050 } }) + '\n'),
    encodeWyomingEvent({
      type: 'audio-chunk',
      data: { rate: 22050 },
      payload: Buffer.from([1, 2, 3, 4]),
    }),
  ]);
  const reader = new WyomingReader();
  const events: WyomingEvent[] = [];
  for (let offset = 0; offset < bytes.length; offset += 3)
    events.push(...reader.push(bytes.subarray(offset, offset + 3)));
  assert.deepEqual(
    events.map((event) => [event.type, event.data, event.payload && [...event.payload]]),
    [
      ['transcript', { text: 'Bonjour à tous' }, null],
      ['audio-start', { rate: 22050 }, null],
      ['audio-chunk', { rate: 22050 }, [1, 2, 3, 4]],
    ],
  );
});

test('Whisper : transcribe, audio en trames, puis transcript', async (t) => {
  const whisper = await fakeService(t, (events, send) => {
    if (events.at(-1)?.type === 'audio-stop')
      send({ type: 'transcript', data: { text: 'Allume le salon' } });
  });
  const pcm = Buffer.alloc(5000, 1);
  const text = await wyomingTranscribe(whisper.address, pcm, { language: 'fr', model: null });
  assert.equal(text, 'Allume le salon');
  const events = whisper.received[0]!;
  assert.deepEqual(events[0], { type: 'transcribe', data: { language: 'fr' }, payload: null });
  assert.deepEqual(events[1]!.data, { rate: 16000, width: 2, channels: 1 });
  const chunks = events.filter((event) => event.type === 'audio-chunk');
  assert.equal(Buffer.concat(chunks.map((event) => event.payload!)).length, 5000);
  assert.equal(events.at(-1)!.type, 'audio-stop');
});

test('Piper : synthesize avec la voix choisie, audio stéréo ramené en mono', async (t) => {
  const piper = await fakeService(t, (events, send) => {
    if (events.at(-1)?.type !== 'synthesize') return;
    const format = { rate: 22050, width: 2, channels: 2 };
    const stereo = Buffer.alloc(8);
    [1000, 3000, -2000, -4000].forEach((value, index) => stereo.writeInt16LE(value, index * 2));
    send({ type: 'audio-start', data: format });
    send({ type: 'audio-chunk', data: format, payload: stereo });
    send({ type: 'audio-stop' });
  });
  const audio = await wyomingSynthesize(piper.address, 'Il fait beau.', {
    voice: 'fr_FR-siwis-medium',
  });
  assert.equal(audio.rate, 22050);
  assert.deepEqual([...audio.pcm], [2000, -3000]);
  assert.deepEqual(piper.received[0]![0]!.data, {
    text: 'Il fait beau.',
    voice: { name: 'fr_FR-siwis-medium' },
  });
});

test('erreurs : service en panne, injoignable ou muet donnent un message clair', async (t) => {
  const broken = await fakeService(t, (_events, send) =>
    send({ type: 'error', data: { text: 'Voix inconnue' } }),
  );
  await assert.rejects(
    wyomingSynthesize(broken.address, 'Test', { voice: 'xx' }),
    /Synthèse vocale Wyoming : Voix inconnue/u,
  );
  const closed = await fakeService(t, () => {});
  const port = closed.address.port;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const unreachable = createServer();
  await new Promise<void>((resolve) => unreachable.listen(0, '127.0.0.1', resolve));
  const freePort = (unreachable.address() as AddressInfo).port;
  await new Promise((resolve) => unreachable.close(resolve));
  await assert.rejects(
    wyomingTranscribe({ host: '127.0.0.1', port: freePort }, Buffer.alloc(10), {
      language: 'fr',
      model: null,
    }),
    /Transcription Wyoming injoignable/u,
  );
  const abort = new AbortController();
  const pending = wyomingTranscribe({ host: '127.0.0.1', port }, Buffer.alloc(10), {
    language: 'fr',
    model: null,
    signal: abort.signal,
  });
  abort.abort();
  await assert.rejects(pending, /interrompue/u);
});

test('conversation locale avec Whisper et Piper de Home Assistant, LLM oMLX', async (t) => {
  const whisper = await fakeService(t, (events, send) => {
    if (events.at(-1)?.type === 'audio-stop')
      send({ type: 'transcript', data: { text: 'Bonjour Cornelius' } });
  });
  const piper = await fakeService(t, (events, send) => {
    if (events.at(-1)?.type !== 'synthesize') return;
    const format = { rate: 22050, width: 2, channels: 1 };
    send({ type: 'audio-start', data: format });
    send({ type: 'audio-chunk', data: format, payload: Buffer.alloc(4410, 9) });
    send({ type: 'audio-stop' });
  });
  const config = localConversationConfig({
    CORNELIUS_CONVERSATION: 'local',
    CORNELIUS_LOCAL_LLM_MODEL: 'qwen',
    CORNELIUS_LOCAL_STT_URL: whisper.url,
    CORNELIUS_LOCAL_TTS_URL: piper.url,
  })!;
  assert.equal(config.stt.model, null, 'modèle Whisper du serveur');
  assert.equal(config.tts.voice, null, 'voix Piper du serveur');
  const llm: string[] = [];
  const fetch = (async (input: string | URL) => {
    llm.push(String(input));
    return new Response(
      'data: ' +
        JSON.stringify({ choices: [{ delta: { content: 'Bonjour !' } }] }) +
        '\n\ndata: [DONE]\n\n',
    );
  }) as typeof globalThis.fetch;
  const events: ConnectServerEvent[] = [];
  const connection = createLocalGateway(config, undefined, { fetch, now: Date.now }).connect!(
    { type: 'live', instructions: 'Tu es Cornelius.' } as never,
    { open: () => {}, event: (event) => events.push(event), failure: () => {} },
  );
  const tone = Buffer.alloc(16000 * 2 * 0.6);
  for (let offset = 0; offset < tone.length; offset += 2)
    tone.writeInt16LE(offset % 4 ? 9000 : -9000, offset);
  const quiet = Buffer.alloc(16000 * 2 * 0.9);
  const audio = Buffer.concat([tone, quiet]);
  for (let offset = 0; offset < audio.length; offset += 1024)
    connection.sendAudio(audio.subarray(offset, offset + 1024));
  for (
    let attempt = 0;
    attempt < 400 && !events.some((e) => String(e.type) === 'session.output_audio.delta');
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  const said = (type: string) =>
    events
      .filter((event) => event.type === type)
      .map((event) => (event as unknown as { delta: string }).delta);
  assert.deepEqual(said('session.input_transcript.delta'), ['Bonjour Cornelius']);
  assert.deepEqual(said('session.output_transcript.delta'), ['Bonjour ! ']);
  assert.ok(said('session.output_audio.delta').length > 0);
  assert.deepEqual(
    llm,
    ['http://127.0.0.1:8000/v1/chat/completions'],
    'aucun appel HTTP de parole',
  );
  assert.deepEqual(piper.received[0]![0]!.data, { text: 'Bonjour !' });
  connection.dispose();
});
