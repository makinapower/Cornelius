import { createServer } from 'node:http';
import { once } from 'node:events';

/** Faux `opencode serve` : sessions, invites, permissions et questions, en mémoire. */
export async function fakeOpencode(password: string | null = 'opencode-fixture-secret') {
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const sessions = new Map<
    string,
    {
      status: 'idle' | 'busy';
      messages: { info: Record<string, unknown>; parts: Record<string, unknown>[] }[];
    }
  >();
  const permissions: Record<string, unknown>[] = [];
  const questions: Record<string, unknown>[] = [];
  let next = 0;
  const id = (prefix: string) => prefix + '_fixture' + ++next;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body: Record<string, unknown> = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    } catch {}
    calls.push({ path: path + url.search, method: req.method ?? 'GET', body });
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(value === undefined ? '' : JSON.stringify(value));
    };
    const expected = password
      ? 'Basic ' + Buffer.from('opencode:' + password).toString('base64')
      : undefined;
    if (req.headers.authorization !== expected) return send({ error: 'unauthorized' }, 401);
    if (path === '/global/health') return send({ healthy: true, version: '1.19.3' });
    if (path === '/project/current') return send({ id: 'p', worktree: '/Users/alice/site' });
    if (path === '/agent')
      return send([
        { name: 'build', description: 'Écrit et modifie le code.', mode: 'primary' },
        { name: 'plan', description: 'Prépare un plan sans rien modifier.', mode: 'primary' },
        { name: 'explore', description: 'Sous-agent de recherche.', mode: 'subagent' },
      ]);
    if (path === '/session' && req.method === 'POST') {
      const session = id('ses');
      sessions.set(session, { status: 'idle', messages: [] });
      return send({ id: session, title: body.title });
    }
    if (path === '/session/status')
      return send(
        Object.fromEntries(
          [...sessions].filter(([, s]) => s.status === 'busy').map(([k]) => [k, { type: 'busy' }]),
        ),
      );
    if (path === '/permission') return send(permissions);
    if (path === '/question') return send(questions);
    const reply = /^\/(permission|question)\/([^/]+)\/reply$/u.exec(path);
    if (reply) {
      const list = reply[1] === 'permission' ? permissions : questions;
      const index = list.findIndex((entry) => entry.id === reply[2]);
      if (index < 0) return send({ error: 'not found' }, 404);
      list.splice(index, 1);
      return send(true);
    }
    const match = /^\/session\/([^/]+)\/(prompt_async|message|abort)$/u.exec(path);
    const session = match ? sessions.get(match[1]!) : undefined;
    if (!match || !session) return send({ error: 'not found' }, 404);
    if (match[2] === 'prompt_async') {
      session.messages.push({
        info: { id: id('msg'), role: 'user', time: { created: Date.now() } },
        parts: body.parts as Record<string, unknown>[],
      });
      session.status = 'busy';
      res.writeHead(204);
      return res.end();
    }
    if (match[2] === 'abort') {
      session.status = 'idle';
      session.messages.push({
        info: {
          id: id('msg'),
          role: 'assistant',
          time: { created: Date.now() },
          error: { name: 'MessageAbortedError', data: {} },
        },
        parts: [],
      });
      return send(true);
    }
    const limit = Number(url.searchParams.get('limit') ?? 100);
    return send(session.messages.slice(-limit));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return {
    url: 'http://127.0.0.1:' + port,
    password,
    calls,
    sessions,
    permissions,
    questions,
    /** opencode termine la session avec une réponse (étapes d’outils puis texte). */
    finish(sessionId: string, text: string) {
      const session = sessions.get(sessionId)!;
      session.status = 'idle';
      session.messages.push(
        {
          info: { id: id('msg'), role: 'assistant', time: { created: 1, completed: 2 } },
          parts: [{ type: 'tool', tool: 'edit' }],
        },
        {
          info: { id: id('msg'), role: 'assistant', time: { created: 3, completed: 4 } },
          parts: [
            { type: 'reasoning', text: 'je réfléchis' },
            { type: 'text', text },
            { type: 'text', text: 'note interne', synthetic: true },
          ],
        },
      );
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
