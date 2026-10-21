import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { openDatabase, ProfileRepository } from '../server/storage.js';
import { AgentRepository } from '../server/agents-store.js';
import { Agents } from '../server/agents.js';
import { HermesClient } from '../server/hermes-client.js';
import { OpencodeClient } from '../server/opencode-client.js';
import { createHttpClient } from '../server/addons/http.js';
import { liveConfiguration } from '../server/live/configuration.js';
import { fakeOpencode } from './helpers/opencode.js';

async function fixture(t: TestContext, password: string | null = 'opencode-fixture-secret') {
  const fake = await fakeOpencode(password),
    db = openDatabase(':memory:');
  const profiles = new ProfileRepository(db),
    alice = profiles.create('Alice');
  const http = createHttpClient();
  const repo = new AgentRepository(db),
    agents = new Agents(repo, new HermesClient(http), Date.now, new OpencodeClient(http));
  t.after(async () => {
    await agents.dispose();
    db.close();
    await fake.close();
  });
  const view = await agents.configure(alice.id, {
    kind: 'opencode',
    url: fake.url,
    ...(password ? { token: password } : {}),
    enabled: true,
    description: 'Mon site web',
    revision: 0,
  });
  const input = () => ({
    profileId: alice.id,
    callId: randomUUID(),
    scope: { interactionId: 'interaction-alice', profileEpoch: 1, contextVersion: 1 },
    signal: new AbortController().signal,
  });
  const run = (name: string, args: unknown) => agents.run(input(), name, args);
  const session = () => [...fake.sessions.keys()].at(-1)!;
  return { fake, db, alice, repo, agents, view, run, session };
}

test('opencode : découverte du projet et des agents principaux, outils et consignes à son nom', async (t) => {
  const f = await fixture(t);
  assert.equal(f.view.connection.kind, 'opencode');
  assert.equal(f.view.connection.discovery?.available, true);
  assert.deepEqual(
    f.view.connection.discovery?.capabilities.map((c) => c.name),
    ['Projet', 'build', 'plan'],
  );
  assert.match(f.view.connection.discovery!.capabilities[0]!.description, /\/Users\/alice\/site/u);
  const tools = f.agents.tools(f.alice.id);
  const start = tools.find((tool) => tool.name === 'agents__start')!.description;
  assert.match(start, /Agent de code opencode/u);
  assert.doesNotMatch(tools.map((tool) => tool.description).join(' '), /Hermes/u);
  const config = liveConfiguration(tools);
  assert.match(config.instructions ?? '', /adressée à opencode/u);
  assert.doesNotMatch(config.instructions ?? '', /Hermes/u);
  assert.ok(!JSON.stringify(f.agents.admin(f.alice.id)).includes('opencode-fixture-secret'));
});

test('opencode : demande, travail, résultat puis suite dans la même session', async (t) => {
  const f = await fixture(t);
  const started = await f.run('agents__start', { message: 'Corrige le bug du formulaire' });
  assert.equal(started.status, 'succeeded');
  assert.equal(started.result?.status, 'running');
  const session = f.session();
  const prompt = f.fake.calls.find((call) => call.path.endsWith('/prompt_async'))!;
  assert.deepEqual(prompt.body.parts, [{ type: 'text', text: 'Corrige le bug du formulaire' }]);
  assert.match(String(prompt.body.system), /Cornelius/u);
  f.fake.finish(session, 'Le formulaire valide maintenant l’adresse e-mail.');
  const taskId = String(started.result?.taskId);
  const done = await f.run('agents__status', { taskId });
  assert.equal(done.result?.status, 'completed');
  assert.equal(done.summary, 'Le formulaire valide maintenant l’adresse e-mail.');
  assert.equal(f.agents.pendingDelivery(f.alice.id)?.id, taskId);

  const follow = await f.run('agents__reply', { taskId, message: 'Ajoute un test' });
  assert.equal(follow.result?.status, 'running');
  assert.equal(f.fake.sessions.size, 1, 'la suite reste dans la même session opencode');
  assert.equal(f.fake.calls.filter((call) => call.path.endsWith('/prompt_async')).length, 2);
});

test('opencode : permission validée ou refusée dans l’administration', async (t) => {
  const f = await fixture(t);
  const started = await f.run('agents__start', { message: 'Installe les dépendances' });
  const taskId = String(started.result?.taskId);
  f.fake.permissions.push({
    id: 'per_1',
    sessionID: f.session(),
    permission: 'bash',
    patterns: ['npm install'],
    metadata: {},
    always: [],
  });
  const waiting = await f.run('agents__status', { taskId });
  assert.equal(waiting.status, 'pending_confirmation');
  assert.match(
    String((waiting.result as { approval?: { description: string } }).approval?.description),
    /bash.*npm install/u,
  );
  const reply = await f.run('agents__reply', { taskId, message: 'vas-y' });
  assert.match(reply.summary, /accord/u);
  await f.agents.approve(f.alice.id, taskId, 'per_1', 'once');
  assert.deepEqual(f.fake.calls.find((call) => call.path === '/permission/per_1/reply')?.body, {
    reply: 'once',
  });
  f.fake.permissions.push({
    id: 'per_2',
    sessionID: f.session(),
    permission: 'edit',
    patterns: [],
  });
  await f.run('agents__status', { taskId });
  await f.agents.approve(f.alice.id, taskId, 'per_2', 'deny');
  assert.deepEqual(f.fake.calls.find((call) => call.path === '/permission/per_2/reply')?.body, {
    reply: 'reject',
  });
});

test('opencode : sa question reçoit la réponse de la personne ; sans question, il travaille', async (t) => {
  const f = await fixture(t);
  const started = await f.run('agents__start', { message: 'Refais la page d’accueil' });
  const taskId = String(started.result?.taskId);
  const busy = await f.run('agents__reply', { taskId, message: 'En bleu' });
  assert.equal(busy.status, 'failed');
  assert.match(busy.summary, /opencode travaille encore/u);
  f.fake.questions.push({
    id: 'que_1',
    sessionID: f.session(),
    questions: [
      {
        question: 'Quelle couleur ?',
        header: 'Couleur',
        options: [{ label: 'Bleu' }, { label: 'Vert' }],
      },
    ],
  });
  const asked = await f.run('agents__status', { taskId });
  assert.match(asked.summary, /Quelle couleur \? \(Bleu, Vert\)/u);
  const answered = await f.run('agents__reply', { taskId, message: 'Bleu' });
  assert.equal(answered.status, 'succeeded');
  assert.deepEqual(f.fake.calls.find((call) => call.path === '/question/que_1/reply')?.body, {
    answers: [['Bleu']],
  });
});

test('opencode : arrêt demandé puis tâche annulée', async (t) => {
  const f = await fixture(t);
  const started = await f.run('agents__start', { message: 'Réécris tout' });
  const taskId = String(started.result?.taskId);
  const stopping = await f.run('agents__cancel', { taskId });
  assert.equal(stopping.result?.status, 'stopping');
  assert.ok(f.fake.calls.some((call) => call.path === '/session/' + f.session() + '/abort'));
  const cancelled = await f.agents.refreshAdmin(f.alice.id);
  assert.equal(cancelled.tasks[0]?.status, 'cancelled');
});

test('opencode : sans mot de passe sur la machine, mauvais mot de passe signalé', async (t) => {
  const open = await fixture(t, null);
  assert.equal(open.view.connection.discovery?.available, true);
  assert.equal(open.view.connection.hasToken, false);
  const locked = await fixture(t);
  const view = await locked.agents.configure(locked.alice.id, {
    kind: 'opencode',
    url: locked.fake.url,
    token: 'mauvais',
    enabled: true,
    description: '',
    revision: locked.view.connection.revision,
  });
  assert.equal(view.connection.discovery?.error, 'opencode a refusé le mot de passe.');
  const refused = await locked.run('agents__start', { message: 'Test' });
  assert.match(refused.summary, /opencode est indisponible/u);
});

test('changer d’agent oublie les tâches de l’ancien', async (t) => {
  const f = await fixture(t);
  await f.run('agents__start', { message: 'Corrige' });
  assert.equal(f.agents.admin(f.alice.id).tasks.length, 1);
  await assert.rejects(
    f.agents.configure(f.alice.id, {
      kind: 'hermes',
      url: f.fake.url,
      enabled: true,
      description: '',
      revision: f.agents.admin(f.alice.id).connection.revision,
    }),
    /jeton est nécessaire/u,
  );
  const hermes = await f.agents.configure(f.alice.id, {
    kind: 'hermes',
    url: f.fake.url,
    token: 'jeton',
    enabled: true,
    description: '',
    revision: f.agents.admin(f.alice.id).connection.revision,
  });
  assert.equal(hermes.connection.kind, 'hermes');
  assert.equal(hermes.tasks.length, 0);
});
