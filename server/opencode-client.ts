import type { AgentCapability, AgentDiscovery } from '../shared/agents.js';
import type { AddonHttpClient } from '../shared/addons.js';
import type { AgentBackend, AgentRunState } from './agent-backend.js';
import type { AgentConnection, AgentTask } from './agents-store.js';
import { HermesError, cleanText, object, remoteId } from './hermes-client.js';

/**
 * Agent de code opencode, par son mode serveur (`opencode serve`). Une demande de Cornelius
 * ouvre une session opencode ; la suite d’une demande terminée continue dans la même session.
 * Les permissions d’opencode deviennent des accords à valider dans l’administration ; ses
 * questions reçoivent la réponse de la personne.
 */
export class OpencodeClient implements AgentBackend {
  constructor(
    private readonly http: AddonHttpClient,
    private readonly now = Date.now,
  ) {}

  /** Mot de passe de `OPENCODE_SERVER_PASSWORD` ; `utilisateur:mot de passe` sinon `opencode`. */
  private authorization(c: AgentConnection): Record<string, string> {
    if (!c.token) return {};
    const credentials = c.token.includes(':') ? c.token : 'opencode:' + c.token;
    return { Authorization: 'Basic ' + Buffer.from(credentials, 'utf8').toString('base64') };
  }

  async request(
    c: AgentConnection,
    path: string,
    options: { body?: unknown; signal?: AbortSignal; maxBytes?: number } = {},
  ): Promise<unknown> {
    if (options.signal?.aborted) throw new HermesError('Demande interrompue.');
    const response = await this.http.fetch({
      url: c.url + path,
      method: options.body === undefined ? 'GET' : 'POST',
      headers: {
        ...this.authorization(c),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal,
      timeoutMs: 8000,
      maxBytes: options.maxBytes ?? 512 * 1024,
    });
    if (response.status < 200 || response.status >= 300) {
      const message =
        response.status === 401 || response.status === 403
          ? 'opencode a refusé le mot de passe.'
          : response.status === 404
            ? 'Ressource opencode introuvable.'
            : 'opencode est indisponible (HTTP ' + response.status + ').';
      throw new HermesError(message, response.status);
    }
    if (response.status === 204 || !response.text().trim()) return null;
    if (response.truncated) throw new HermesError('Réponse opencode trop longue.');
    try {
      return response.json();
    } catch {
      throw new HermesError('Réponse opencode illisible.');
    }
  }
  private redact(c: AgentConnection, value: unknown, max?: number) {
    const text = cleanText(value, max);
    return c.token ? text.split(c.token).join('[masqué]') : text;
  }

  async discover(c: AgentConnection, signal?: AbortSignal): Promise<AgentDiscovery> {
    const base: AgentDiscovery = {
      checkedAt: this.now(),
      available: false,
      error: null,
      capabilities: [],
      catalogComplete: true,
      issues: [],
      // Permissions d’opencode : accords validés dans l’administration.
      approval: true,
      // Réponse aux questions d’opencode pendant son travail.
      steer: true,
    };
    try {
      const health = object(await this.request(c, '/global/health', { signal }));
      if (health.healthy !== true) throw new HermesError('opencode ne se dit pas prêt.');
      base.available = true;
      const [project, agents] = await Promise.allSettled([
        this.request(c, '/project/current', { signal }),
        this.request(c, '/agent', { signal }),
      ]);
      if (project.status === 'fulfilled') {
        const worktree = this.redact(c, object(project.value).worktree, 300);
        if (worktree)
          base.capabilities.push({
            name: 'Projet',
            kind: 'toolset',
            description:
              'Dossier de travail d’opencode : ' +
              worktree +
              (typeof health.version === 'string'
                ? ' (opencode ' + this.redact(c, health.version, 40) + ')'
                : ''),
            tools: [],
          });
      }
      if (agents.status === 'rejected' || !Array.isArray(agents.value)) {
        base.catalogComplete = false;
        base.issues!.push({
          kind: 'skill',
          message:
            agents.status === 'rejected' && agents.reason instanceof HermesError
              ? agents.reason.message
              : 'La liste des agents d’opencode est illisible.',
        });
      } else {
        for (const raw of agents.value.slice(0, 50)) {
          const agent = object(raw);
          // Agents principaux seulement : les sous-agents sont appelés par opencode lui-même.
          if (agent.mode === 'subagent' || agent.hidden === true) continue;
          const name = this.redact(c, agent.name, 100);
          if (!name) continue;
          const capability: AgentCapability = {
            name,
            kind: 'skill',
            description: this.redact(c, agent.description, 350) || 'Agent opencode.',
            tools: [],
          };
          base.capabilities.push(capability);
        }
      }
    } catch (error) {
      base.available = false;
      base.catalogComplete = false;
      base.error =
        error instanceof HermesError ? error.message : 'Connexion à opencode indisponible.';
    }
    return base;
  }

  async submit(
    c: AgentConnection,
    _task: AgentTask,
    message: string,
    previous: AgentTask | null,
    signal: AbortSignal,
  ): Promise<string> {
    let sessionId = previous?.runId ?? null;
    if (!sessionId) {
      const created = object(
        await this.request(c, '/session', {
          body: { title: 'Cornelius · ' + message.replace(/\s+/gu, ' ').slice(0, 60) },
          signal,
        }),
      );
      sessionId = remoteId(created.id);
      if (!sessionId) throw new HermesError('Identifiant de session opencode manquant.');
    }
    await this.request(c, '/session/' + encodeURIComponent(sessionId) + '/prompt_async', {
      body: {
        parts: [{ type: 'text', text: message }],
        system:
          'La demande arrive à la voix par le miroir Cornelius, de la part de la personne qui utilise ce projet. Réponds en français. Termine par un court résumé de ce que tu as fait, lisible à voix haute.',
      },
      signal,
    });
    return sessionId;
  }

  async status(
    c: AgentConnection,
    task: AgentTask,
    latest: boolean,
    signal?: AbortSignal,
  ): Promise<AgentRunState> {
    const sessionId = task.runId!;
    // Une demande suivante a pris la session : celle-ci est finie, son résultat a été donné.
    if (!latest) return { status: 'completed', output: null, approval: null, error: null };
    const [statuses, permissions, questions] = await Promise.all([
      this.request(c, '/session/status', { signal }),
      this.request(c, '/permission', { signal }).catch(() => []),
      this.request(c, '/question', { signal }).catch(() => []),
    ]);
    const permission = (Array.isArray(permissions) ? permissions : [])
      .map(object)
      .find((request) => request.sessionID === sessionId);
    const id = permission ? remoteId(permission.id) : null;
    if (permission && id) {
      const patterns = Array.isArray(permission.patterns)
        ? permission.patterns.map((value) => this.redact(c, value, 200)).filter(Boolean)
        : [];
      return {
        status: 'waiting_for_approval',
        output: null,
        approval: {
          id,
          description:
            'opencode demande la permission « ' +
            (this.redact(c, permission.permission, 80) || 'action') +
            ' »' +
            (patterns.length ? ' pour : ' + patterns.slice(0, 5).join(', ') : '') +
            '.',
        },
        error: null,
      };
    }
    const question = (Array.isArray(questions) ? questions : [])
      .map(object)
      .find((request) => request.sessionID === sessionId);
    if (question) {
      const asked = (Array.isArray(question.questions) ? question.questions : [])
        .map(object)
        .map((entry) => {
          const options = Array.isArray(entry.options)
            ? entry.options.map((option) => this.redact(c, object(option).label, 80))
            : [];
          return (
            this.redact(c, entry.question, 500) +
            (options.filter(Boolean).length ? ' (' + options.filter(Boolean).join(', ') + ')' : '')
          );
        })
        .filter(Boolean);
      return {
        status: 'running',
        output: 'opencode pose une question : ' + asked.join(' ; '),
        approval: null,
        error: null,
      };
    }
    const state = object(object(statuses)[sessionId]).type;
    if (state === 'busy' || state === 'retry')
      return { status: 'running', output: null, approval: null, error: null };
    const messages = await this.request(
      c,
      '/session/' + encodeURIComponent(sessionId) + '/message?limit=20',
      { signal, maxBytes: 4 * 1024 * 1024 },
    );
    if (!Array.isArray(messages))
      throw new HermesError('Messages opencode illisibles ; aucune réussite confirmée.');
    const entries = messages.map(object);
    const last = object(entries.at(-1)?.info);
    // La demande vient d’arriver : opencode ne l’a pas encore prise.
    if (last.role !== 'assistant')
      return { status: 'queued', output: null, approval: null, error: null };
    const error = object(last.error);
    if (error.name === 'MessageAbortedError')
      return { status: 'cancelled', output: null, approval: null, error: null };
    if (error.name)
      return {
        status: 'failed',
        output: null,
        approval: null,
        error:
          'opencode signale une erreur : ' +
          (this.redact(c, object(error.data).message, 300) || this.redact(c, error.name, 80)),
      };
    if (!object(last.time).completed)
      return { status: 'running', output: null, approval: null, error: null };
    // Réponse : le dernier texte de l’assistant (les étapes d’outils précèdent).
    let output = '';
    for (let index = entries.length - 1; index >= 0 && !output; index--) {
      const entry = entries[index]!;
      if (object(entry.info).role !== 'assistant') break;
      output = (Array.isArray(entry.parts) ? entry.parts : [])
        .map(object)
        .filter((part) => part.type === 'text' && part.synthetic !== true && part.ignored !== true)
        .map((part) => this.redact(c, part.text))
        .join('\n')
        .trim();
    }
    return { status: 'completed', output: output || null, approval: null, error: null };
  }

  /** Réponse de la personne à une question d’opencode ; sinon, opencode travaille encore. */
  async steer(c: AgentConnection, task: AgentTask, message: string, signal?: AbortSignal) {
    const questions = await this.request(c, '/question', { signal });
    const question = (Array.isArray(questions) ? questions : [])
      .map(object)
      .find((request) => request.sessionID === task.runId);
    const id = question ? remoteId(question.id) : null;
    if (!question || !id)
      throw new HermesError('opencode travaille encore sur cette demande. Attendez son résultat.');
    const count = Array.isArray(question.questions) ? Math.max(1, question.questions.length) : 1;
    await this.request(c, '/question/' + encodeURIComponent(id) + '/reply', {
      body: { answers: Array.from({ length: count }, () => [message]) },
      signal,
    });
  }
  async stop(c: AgentConnection, task: AgentTask, signal?: AbortSignal) {
    await this.request(c, '/session/' + encodeURIComponent(task.runId!) + '/abort', {
      body: {},
      signal,
    });
  }
  async approve(
    c: AgentConnection,
    _task: AgentTask,
    requestId: string,
    choice: 'once' | 'deny',
    signal?: AbortSignal,
  ) {
    await this.request(c, '/permission/' + encodeURIComponent(requestId) + '/reply', {
      body: { reply: choice === 'once' ? 'once' : 'reject' },
      signal,
    });
  }
}
