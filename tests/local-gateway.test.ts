import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectServerEvent } from 'openai/resources/live/sideband';
import {
  completeSentences,
  createLocalGateway,
  decodeWav,
  encodeWav,
  Endpointer,
  localConversationConfig,
  resample,
  visibleText,
} from '../server/live/local-gateway.js';

const tone = (ms: number, amplitude: number, rate = 16000) => {
  const samples = Math.round((rate * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++)
    pcm.writeInt16LE(Math.round(Math.sin(index / 5) * amplitude), index * 2);
  return pcm;
};
const frames = (pcm: Buffer) => {
  const list: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += 1024)
    list.push(pcm.subarray(offset, offset + 1024));
  return list;
};

test('configuration : OpenAI par défaut, local avec oMLX et mlx-audio sur la machine', () => {
  assert.equal(localConversationConfig({}), null);
  const config = localConversationConfig({ CORNELIUS_CONVERSATION: 'local' })!;
  assert.equal(config.llm.baseUrl, 'http://127.0.0.1:8000/v1');
  assert.equal(config.llm.model, null);
  assert.equal(config.stt.baseUrl, 'http://127.0.0.1:8001/v1');
  assert.equal(config.tts.voice, 'ff_siwis');
  assert.equal(config.tts.langCode, 'f');
  const custom = localConversationConfig({
    CORNELIUS_CONVERSATION: 'LOCAL',
    CORNELIUS_LOCAL_LLM_URL: 'http://mac.local:9000/v1/',
    CORNELIUS_LOCAL_LLM_MODEL: 'qwen',
    CORNELIUS_LOCAL_AUDIO_URL: 'http://127.0.0.1:9001/v1',
    CORNELIUS_LOCAL_TTS_LANG_CODE: 'non',
    CORNELIUS_LOCAL_TTS_SPEED: '9',
  })!;
  assert.equal(custom.llm.baseUrl, 'http://mac.local:9000/v1');
  assert.equal(custom.llm.model, 'qwen');
  assert.equal(custom.tts.baseUrl, 'http://127.0.0.1:9001/v1');
  assert.equal(custom.tts.langCode, null);
  assert.equal(custom.tts.speed, 1, 'une vitesse hors bornes revient à 1');
});

test('WAV : aller-retour PCM16, flottant 32 bits et stéréo mélangé', () => {
  const pcm = tone(50, 8000);
  const decoded = decodeWav(encodeWav(pcm, 16000));
  assert.equal(decoded.rate, 16000);
  assert.deepEqual(Buffer.from(decoded.pcm.buffer), pcm);

  const float = Buffer.alloc(44 + 2 * 2 * 4);
  float.write('RIFF', 0, 'ascii');
  float.write('WAVEfmt ', 8, 'ascii');
  float.writeUInt32LE(16, 16);
  float.writeUInt16LE(3, 20);
  float.writeUInt16LE(2, 22);
  float.writeUInt32LE(24000, 24);
  float.writeUInt16LE(32, 34);
  float.write('data', 36, 'ascii');
  float.writeUInt32LE(16, 40);
  [0.5, 0.5, -1, 0].forEach((value, index) => float.writeFloatLE(value, 44 + index * 4));
  const stereo = decodeWav(float);
  assert.equal(stereo.rate, 24000);
  assert.deepEqual([...stereo.pcm], [Math.round(0.5 * 32767), Math.round(-0.5 * 32767)]);
  assert.throws(() => decodeWav(Buffer.from('pas un wav')), /WAV attendu/u);
});

test('rééchantillonnage : la durée suit le nouveau débit', () => {
  const pcm = new Int16Array(24000).fill(1000);
  assert.equal(resample(pcm, 24000, 16000).length, 16000);
  assert.equal(resample(pcm, 24000, 24000), pcm);
});

test('fin de parole : un silence clôt la phrase, un bruit bref ne compte pas', () => {
  const utterances: Buffer[] = [];
  const endpointer = new Endpointer((pcm) => utterances.push(pcm));
  for (const frame of frames(Buffer.concat([tone(500, 20), tone(30, 9000), tone(1000, 20)])))
    endpointer.push(frame);
  assert.equal(utterances.length, 0, 'claquement de 30 ms ignoré');
  for (const frame of frames(Buffer.concat([tone(600, 9000), tone(900, 20)])))
    endpointer.push(frame);
  assert.equal(utterances.length, 1);
  // Durée : parole, avance gardée et silence de fin.
  assert.ok(utterances[0]!.length / 32 > 1300);
});

test('phrases : dites au fil de l’eau, raisonnement et markdown retirés', () => {
  assert.deepEqual(completeSentences('Il fait beau. Vingt degrés! Et dem'), {
    sentences: ['Il fait beau.', 'Vingt degrés!'],
    rest: ' Et dem',
  });
  assert.equal(visibleText('<think>calcul</think> **Bonjour** !'), 'Bonjour !');
  assert.equal(visibleText('<think>encore en cours'), '');
});

/** Réponses HTTP successives du faux serveur local, selon l’adresse appelée. */
function fakeServers(llmStreams: string[][]) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ url, body });
    if (url.endsWith('/audio/transcriptions'))
      return Response.json({ text: 'Quelle heure est-il ?' });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'qwen3-8b' }] });
    if (url.endsWith('/audio/speech'))
      return new Response(new Uint8Array(encodeWav(tone(200, 3000, 24000), 24000)));
    if (url.endsWith('/chat/completions')) {
      const lines = llmStreams.shift() ?? [];
      const text = lines.map((line) => 'data: ' + line + '\n\n').join('') + 'data: [DONE]\n\n';
      return new Response(text);
    }
    return new Response('inconnu', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const chunk = (delta: unknown) => JSON.stringify({ choices: [{ delta }] });

test('conversation : transcription, outil exécuté par le serveur, puis réponse dite', async () => {
  const config = localConversationConfig({ CORNELIUS_CONVERSATION: 'local' })!;
  const { fetch, calls } = fakeServers([
    [
      chunk({ content: '<think>il faut l’heure</think>' }),
      chunk({
        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'clock__read', arguments: '{' } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }),
    ],
    [chunk({ content: 'Il est quatorze heures. ' }), chunk({ content: 'Bonne journée !' })],
  ]);
  const events: ConnectServerEvent[] = [];
  let opened = false;
  const gateway = createLocalGateway(config, undefined, { fetch, now: Date.now });
  assert.equal(gateway.local, true);
  const connection = gateway.connect!(
    {
      type: 'live',
      model: 'gpt-live-1',
      instructions: 'Tu es Cornelius.',
      audio: { output: { voice: 'cedar' }, format: { type: 'audio/pcm', rate: 16000 } },
      delegation: {
        type: 'responses',
        responses: {
          model: 'gpt-6-luna',
          instructions: 'Utilise clock__read pour l’heure.',
          tools: [
            { type: 'web_search' },
            {
              type: 'function',
              name: 'clock__read',
              description: 'Heure locale',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
      },
    } as never,
    { open: () => (opened = true), event: (event) => events.push(event), failure: () => {} },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened, true);
  assert.equal(events[0]?.type, 'session.started');

  for (const frame of frames(Buffer.concat([tone(600, 9000), tone(900, 20)])))
    connection.sendAudio(frame);
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(predicate());
  };
  const of = (type: string) => events.filter((event) => event.type === type);
  const inner = (type: string) =>
    of('response.event').filter(
      (event) => (event as unknown as { event: { type: string } }).event.type === type,
    ) as unknown as { delegation_id: string; event: Record<string, unknown> }[];
  await waitFor(() => inner('response.completed').length === 1);

  const transcription = calls.find((call) => call.url.endsWith('/audio/transcriptions'))!;
  assert.ok(transcription.body instanceof FormData);
  assert.equal((transcription.body as FormData).get('language'), 'fr');
  assert.equal(
    (of('session.input_transcript.delta')[0] as unknown as { delta: string }).delta,
    'Quelle heure est-il ?',
  );
  assert.equal(of('session.delegation.created').length, 1);
  const [call] = inner('response.output_item.done');
  assert.deepEqual(
    { ...(call!.event.item as object), id: undefined },
    {
      type: 'function_call',
      id: undefined,
      call_id: 'call_1',
      name: 'clock__read',
      arguments: '{}',
    },
  );
  const request = calls.find((entry) => entry.url.endsWith('/chat/completions'))!.body as {
    model: string;
    tools: { function: { name: string } }[];
    messages: { role: string; content: string }[];
  };
  assert.equal(request.model, 'qwen3-8b', 'premier modèle servi');
  assert.deepEqual(
    request.tools.map((tool) => tool.function.name),
    ['clock__read'],
    'web_search n’existe pas en local',
  );
  assert.match(
    request.messages[0]!.content,
    /Tu es Cornelius[\s\S]*clock__read[\s\S]*Fonctionnement local/u,
  );
  assert.equal(of('session.output_transcript.delta').length, 0, 'raisonnement jamais dit');

  // Le serveur de Cornelius renvoie le résultat de l’outil puis relance le modèle.
  connection.send({
    type: 'response.item.create',
    item: { type: 'function_call_output', call_id: 'call_1', output: '{"time":"14:00"}' },
  } as never);
  connection.send({ type: 'response.create' } as never);
  await waitFor(() => of('session.output_transcript.delta').length === 2);
  const second = calls.filter((entry) => entry.url.endsWith('/chat/completions'))[1]!.body as {
    messages: { role: string; tool_call_id?: string }[];
  };
  assert.deepEqual(
    second.messages.slice(-2).map((message) => message.role),
    ['assistant', 'tool'],
  );
  assert.deepEqual(
    of('session.output_transcript.delta').map(
      (event) => (event as unknown as { delta: string }).delta,
    ),
    ['Il est quatorze heures. ', 'Bonne journée ! '],
  );
  const speech = calls.find((entry) => entry.url.endsWith('/audio/speech'))!.body as Record<
    string,
    unknown
  >;
  assert.equal(speech.voice, 'ff_siwis');
  assert.equal(speech.lang_code, 'f');
  await waitFor(() => of('session.output_audio.delta').length > 0);
  // Pendant que Cornelius parle, son propre son ne relance pas la transcription.
  const transcriptions = calls.filter((entry) =>
    entry.url.endsWith('/audio/transcriptions'),
  ).length;
  for (const frame of frames(Buffer.concat([tone(600, 9000), tone(900, 20)])))
    connection.sendAudio(frame);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    calls.filter((entry) => entry.url.endsWith('/audio/transcriptions')).length,
    transcriptions,
  );

  connection.send({ type: 'session.close' } as never);
  await waitFor(() => of('session.closed').length === 1);
});

test('contexte caméra confirmé et consigne d’accueil dite', async () => {
  const config = localConversationConfig({
    CORNELIUS_CONVERSATION: 'local',
    CORNELIUS_LOCAL_LLM_MODEL: 'gemma',
  })!;
  const { fetch, calls } = fakeServers([[chunk({ content: 'Bonjour Alice.' })]]);
  const events: ConnectServerEvent[] = [];
  const connection = createLocalGateway(config, undefined, { fetch, now: Date.now }).connect!(
    { type: 'live', instructions: 'Tu es Cornelius.' } as never,
    { open: () => {}, event: (event) => events.push(event), failure: () => {} },
  );
  connection.send({
    type: 'session.thinking.append',
    event_id: 'ctx',
    content: 'Une tasse rouge.',
  } as never);
  assert.deepEqual(events.at(-1), { type: 'session.thinking.appended', client_event_id: 'ctx' });
  connection.send({ type: 'session.commentary.append', content: 'Démarre en saluant.' } as never);
  for (
    let attempt = 0;
    attempt < 200 && !events.some((e) => e.type === 'session.output_transcript.delta');
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  const request = calls.find((entry) => entry.url.endsWith('/chat/completions'))!.body as {
    model: string;
    tools?: unknown;
    messages: { role: string; content: string }[];
  };
  assert.equal(request.model, 'gemma');
  assert.equal(request.tools, undefined, 'aucun outil : pas de champ tools');
  assert.match(request.messages[0]!.content, /Une tasse rouge/u);
  assert.equal(request.messages[1]!.content, '[Consigne du serveur] Démarre en saluant.');
  assert.equal(
    calls.some((entry) => entry.url.endsWith('/models')),
    false,
  );
  connection.dispose();
});

test('une panne du LLM local est signalée comme une erreur de session', async () => {
  const config = localConversationConfig({
    CORNELIUS_CONVERSATION: 'local',
    CORNELIUS_LOCAL_LLM_MODEL: 'x',
  })!;
  const fetch = (async () =>
    new Response('', { status: 503 })) as unknown as typeof globalThis.fetch;
  const events: ConnectServerEvent[] = [];
  const connection = createLocalGateway(config, undefined, { fetch, now: Date.now }).connect!(
    { type: 'live' } as never,
    { open: () => {}, event: (event) => events.push(event), failure: () => {} },
  );
  connection.send({ type: 'session.commentary.append', content: 'Démarre.' } as never);
  for (let attempt = 0; attempt < 200 && !events.some((e) => e.type === 'error'); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const error = events.find((event) => event.type === 'error') as unknown as {
    error: { message: string };
  };
  assert.match(error.error.message, /HTTP 503/u);
  connection.dispose();
});

test('LLM sur une autre machine : clé envoyée, clé refusée et machine injoignable dites clairement', async () => {
  const config = localConversationConfig({
    CORNELIUS_CONVERSATION: 'local',
    CORNELIUS_LOCAL_LLM_URL: 'http://192.168.1.30:8000/v1',
    CORNELIUS_LOCAL_LLM_API_KEY: 'secret-omlx',
  })!;
  const run = async (answer: (url: string) => Response) => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return answer(String(input));
    }) as typeof globalThis.fetch;
    const events: ConnectServerEvent[] = [];
    const connection = createLocalGateway(config, undefined, { fetch, now: Date.now }).connect!(
      { type: 'live' } as never,
      { open: () => {}, event: (event) => events.push(event), failure: () => {} },
    );
    connection.send({ type: 'session.commentary.append', content: 'Démarre.' } as never);
    for (let attempt = 0; attempt < 200 && !events.some((e) => e.type === 'error'); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    connection.dispose();
    const error = events.find((event) => event.type === 'error') as unknown as {
      error: { message: string };
    };
    return { seen, message: error.error.message };
  };
  const refused = await run(() => new Response('', { status: 401 }));
  assert.deepEqual(refused.seen[0], {
    url: 'http://192.168.1.30:8000/v1/models',
    authorization: 'Bearer secret-omlx',
  });
  assert.match(refused.message, /clé refusée/u);
  const unreachable = await run(() => {
    throw new TypeError('fetch failed');
  });
  assert.match(unreachable.message, /injoignable \(http:\/\/192\.168\.1\.30:8000\/v1\/models\)/u);
});
