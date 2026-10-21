import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { SessionConfig } from 'openai/resources/live/live';
import type { ConnectClientEvent, ConnectServerEvent } from 'openai/resources/live/sideband';
import card from '../schemas/examples/luna-card.json' with { type: 'json' };
import { openDatabase, ProfileRepository, SessionPreferences } from '../server/storage.js';
import { SessionController } from '../server/controller.js';
import { LOCAL_BROWSER_AUDIO_RATE, LiveTransport } from '../server/live/transport.js';
import type { LiveGateway, LiveHandlers } from '../server/live/gateway.js';
import { DiagnosticLog } from '../server/logs.js';

/** Contrôleur et transport réels, moteur local simulé : le miroir parle sans WebRTC. */
function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  let now = Date.now();
  const profiles = new ProfileRepository(db);
  const preferences = new SessionPreferences(db);
  const sent: ConnectClientEvent[] = [];
  const audio: Buffer[] = [];
  const sessions: SessionConfig[] = [];
  let handlers!: LiveHandlers;
  const gateway: LiveGateway = {
    local: true,
    async create() {
      throw new Error('WebRTC inattendu en local.');
    },
    attach() {
      throw new Error('Canal latéral inattendu en local.');
    },
    connect(session, value) {
      sessions.push(session);
      handlers = value;
      return {
        send: (event) => sent.push(event),
        sendAudio: (pcm) => audio.push(pcm),
        dispose() {},
      };
    },
  };
  const live = new LiveTransport(
    gateway,
    () => preferences.getOpenAIBlocked(),
    new DiagnosticLog(),
    {},
    () => now,
  );
  const controller = new SessionController(profiles, live, () => now, preferences);
  live.attach(controller);
  const played: [string, Buffer][] = [];
  live.attachBrowserOutput((id, pcm) => played.push([id, pcm]));
  t.after(() => {
    live.dispose();
    db.close();
  });
  let sequence = 0;
  const observe = () => {
    controller.heartbeat();
    controller.observe({
      schemaVersion: 1,
      producerBootId: 'camera',
      sequence: ++sequence,
      observedAt: now,
      health: 'ok',
      presence: true,
      engaged: true,
      people: [{ trackId: 'person', profileId: null }],
    });
  };
  observe();
  now += 900;
  observe();
  const emit = (event: unknown) => handlers.event(event as ConnectServerEvent);
  return { live, controller, sent, audio, sessions, played, emit, scope: controller.scope() };
}

test('local : le miroir ouvre la conversation sans WebRTC, son par /audio', async (t) => {
  const f = fixture(t);
  assert.equal(f.live.isLocal(), true);
  const answer = (await f.live.offer(f.scope, 'sdp')) as unknown as { local?: boolean };
  assert.equal(answer.local, true);
  assert.equal(f.sessions.length, 1);
  const session = f.sessions[0]!;
  assert.deepEqual(session.audio?.format, { type: 'audio/pcm', rate: LOCAL_BROWSER_AUDIO_RATE });
  const tools =
    session.delegation?.type === 'responses'
      ? (session.delegation.responses.tools ?? []).map((tool) =>
          'name' in tool ? tool.name : tool.type,
        )
      : [];
  assert.equal(tools.includes('web_search'), false, 'pas de recherche web en local');
  assert.equal(tools.includes('ui__show_luna_card'), true, 'le miroir garde ses cartes');
  assert.doesNotMatch(String(session.instructions), /Satellite audio/u);

  // Avant le démarrage du moteur, le micro ne part pas.
  f.live.browserAudio(f.scope.interactionId!, Buffer.alloc(1024, 1));
  assert.equal(f.audio.length, 0);
  f.emit({ type: 'session.started', session: { id: 'local_1' } });
  assert.equal(f.controller.sessionState().phase, 'ready');
  f.live.browserAudio(f.scope.interactionId!, Buffer.alloc(1024, 1));
  f.live.browserAudio('autre-interaction', Buffer.alloc(1024, 1));
  assert.equal(f.audio.length, 1);

  const pcm = Buffer.alloc(4800, 7);
  f.emit({ type: 'session.output_audio.delta', delta: pcm.toString('base64') });
  assert.deepEqual(f.played, [[f.scope.interactionId, pcm]]);

  // Une carte demandée par le modèle local passe par les mêmes vérifications qu’avec OpenAI.
  const response = (event: Record<string, unknown>) =>
    f.emit({ type: 'response.event', delegation_id: 'dlg_1', event });
  f.emit({ type: 'session.delegation.created', delegation_id: 'dlg_1' });
  response({ type: 'response.created', response: { id: 'resp_1' } });
  response({
    type: 'response.output_item.done',
    response_id: 'resp_1',
    item: {
      type: 'function_call',
      call_id: 'call_card',
      name: 'ui__show_luna_card',
      arguments: JSON.stringify(card),
    },
  });
  response({ type: 'response.completed', response: { id: 'resp_1', output: [] } });
  const output = f.sent.find((event) => event.type === 'response.item.create') as unknown as {
    item: { call_id: string; output: string };
  };
  assert.equal(output.item.call_id, 'call_card');
  assert.deepEqual(JSON.parse(output.item.output), { accepted: true });
  assert.equal(f.sent.filter((event) => event.type === 'response.create').length, 1);
  const shown = f.controller.snapshot().state.cards[0]?.content as { title?: string } | undefined;
  assert.equal(shown?.title, card.title);

  f.live.close(f.scope.interactionId!);
  assert.ok(f.sent.some((event) => event.type === 'session.close'));
  f.emit({ type: 'session.closed' });
  f.live.browserAudio(f.scope.interactionId!, Buffer.alloc(1024, 1));
  assert.equal(f.audio.length, 1);
});
