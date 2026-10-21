import type { AgentCapability, AgentDiscovery, AgentTaskView } from '../shared/agents.js';
import { agentTaskLabels } from '../shared/agents.js';
import type { AddonHttpClient } from '../shared/addons.js';
import { safeUrl } from './addons/http.js';
import type { AgentBackend, AgentRunState } from './agent-backend.js';
import type { AgentConnection, AgentTask } from './agents-store.js';

export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const cleanText = (value: unknown, max = 16000): string =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .trim()
        .slice(0, max)
    : '';
export const remoteId = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : null;
export class HermesError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
export function hermesUrl(raw: string): string {
  const url = safeUrl(raw.trim());
  if (url.search || url.hash)
    throw new HermesError('Adresse sans paramètres ni fragment requise.', 400);
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return url.href.replace(/\/+$/, '');
}
export class HermesClient implements AgentBackend {
  constructor(
    private readonly http: AddonHttpClient,
    private readonly now = Date.now,
  ) {}
  async request(
    c: AgentConnection,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ) {
    if (signal?.aborted) throw new HermesError('Demande interrompue.');
    const response = await this.http.fetch({
      url: c.url + path,
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + c.token,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      timeoutMs: 5000,
      maxBytes: 256 * 1024,
    });
    if (response.status < 200 || response.status >= 300) {
      const message =
        response.status === 401 || response.status === 403
          ? 'Hermes a refusé le jeton ou les droits.'
          : response.status === 404
            ? 'Ressource Hermes introuvable.'
            : response.status === 409
              ? 'Hermes ne peut pas accepter cette demande dans son état actuel.'
              : 'Hermes est indisponible (HTTP ' + response.status + ').';
      throw new HermesError(message, response.status);
    }
    let data: Record<string, unknown>;
    try {
      data = object(response.json());
    } catch {
      throw new HermesError('Réponse Hermes illisible.');
    }
    if (!Object.keys(data).length) throw new HermesError('Réponse Hermes vide ou invalide.');
    return data;
  }
  redact(c: AgentConnection, value: unknown, max?: number) {
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
      approval: false,
      steer: false,
    };
    try {
      const caps = await this.request(c, '/v1/capabilities', undefined, signal);
      const features = object(caps.features);
      if (
        features.run_submission !== true ||
        features.run_status !== true ||
        features.run_stop !== true
      )
        throw new HermesError(
          'Cette version de Hermes doit exposer la création, le suivi et l’arrêt des tâches.',
        );
      base.available = true;
      base.approval = features.run_approval_response === true || features.run_approval === true;
      base.steer = features.run_steer === true;
      const catalogs = await Promise.allSettled([
        this.request(c, '/v1/toolsets', undefined, signal),
        this.request(c, '/v1/skills', undefined, signal),
      ]);
      for (let i = 0; i < catalogs.length; i++) {
        const catalog = catalogs[i]!;
        if (catalog.status === 'rejected' || !Array.isArray(catalog.value.data)) {
          base.catalogComplete = false;
          base.issues!.push({
            kind: i === 0 ? 'toolset' : 'skill',
            message:
              catalog.status === 'rejected'
                ? catalog.reason instanceof HermesError
                  ? catalog.reason.message
                  : 'Impossible de joindre cette API Hermes.'
                : 'Le catalogue reçu a un format invalide.',
          });
          continue;
        }
        const rows = catalog.value.data;
        if (rows.length > 150) {
          base.catalogComplete = false;
          base.issues!.push({
            kind: i === 0 ? 'toolset' : 'skill',
            message: 'Catalogue limité aux 150 premières entrées.',
          });
        }
        for (const raw of rows.slice(0, 150)) {
          const row = object(raw);
          if (i === 0 && (row.enabled !== true || row.configured !== true)) continue;
          if (
            i === 1 &&
            (row.disabled === true || row.enabled === false || row.available === false)
          )
            continue;
          const name = this.redact(c, row.name, 100);
          if (!name) continue;
          const capability: AgentCapability = {
            name,
            kind: i === 0 ? 'toolset' : 'skill',
            description: this.redact(c, row.description, 350),
            tools: Array.isArray(row.tools)
              ? row.tools
                  .map((t) => this.redact(c, t, 80))
                  .filter(Boolean)
                  .slice(0, 30)
              : [],
          };
          base.capabilities.push(capability);
        }
      }
    } catch (error) {
      base.available = false;
      base.catalogComplete = false;
      base.error =
        error instanceof HermesError ? error.message : 'Connexion à Hermes indisponible.';
    }
    return base;
  }
  parseRun(
    c: AgentConnection,
    data: Record<string, unknown>,
  ): Pick<AgentTaskView, 'status' | 'output' | 'approval' | 'error'> {
    const rawStatus = data.status === 'started' ? 'running' : data.status;
    if (typeof rawStatus !== 'string' || !Object.hasOwn(agentTaskLabels, rawStatus))
      throw new HermesError('État Hermes inconnu ; aucune réussite ne peut être confirmée.');
    const status = rawStatus as AgentTaskView['status'];
    const approval = object(data.approval);
    const id = remoteId(approval.request_id);
    return {
      status,
      output: this.redact(c, data.output) || null,
      approval:
        status === 'waiting_for_approval' && id
          ? {
              id,
              description:
                this.redact(
                  c,
                  approval.description || approval.command || approval.message || approval.reason,
                  2000,
                ) || 'Hermes demande votre accord pour poursuivre.',
            }
          : null,
      error:
        status === 'failed' || status === 'interrupted'
          ? 'Hermes signale que cette tâche n’a pas abouti.'
          : null,
    };
  }
  async history(c: AgentConnection, sessionId: string, signal?: AbortSignal) {
    const result = await this.request(
      c,
      '/api/sessions/' + encodeURIComponent(sessionId) + '/messages?order=latest&limit=50',
      undefined,
      signal,
    );
    if (!Array.isArray(result.data)) return null;
    const messages = result.data
      .map(object)
      .filter(
        (m) =>
          m.role === 'assistant' &&
          !m.tool_calls &&
          m.display_kind !== 'interim' &&
          m.display_kind !== 'reasoning',
      );
    const last = messages.at(-1);
    return last ? this.redact(c, last.content) || null : null;
  }
  async submit(
    c: AgentConnection,
    task: AgentTask,
    message: string,
    _previous: AgentTask | null,
    signal: AbortSignal,
  ): Promise<string> {
    const data = await this.request(
      c,
      '/v1/runs',
      {
        input: message,
        session_id: task.sessionId,
        instructions:
          'Réponds en français. La demande arrive via le miroir Cornelius. Donne une réponse claire, avec sources si utile. Gère tes actions, précisions et accords selon tes propres règles.',
      },
      signal,
      task.id,
    );
    const runId = remoteId(data.run_id);
    if (!runId) throw new HermesError('Identifiant de tâche Hermes manquant.');
    return runId;
  }
  async status(
    c: AgentConnection,
    task: AgentTask,
    latest: boolean,
    signal?: AbortSignal,
  ): Promise<AgentRunState> {
    try {
      const data = await this.request(c, '/v1/runs/' + task.runId, undefined, signal);
      if (data.run_id && data.run_id !== task.runId)
        throw new HermesError('Réponse Hermes hors de la tâche demandée.');
      return this.parseRun(c, data);
    } catch (error) {
      // Hermes oublie une tâche finie : sa réponse reste dans l’historique de la conversation.
      if (
        !(error instanceof HermesError) ||
        error.status !== 404 ||
        task.status !== 'completed' ||
        !latest
      )
        throw error;
      return {
        status: 'completed',
        output: await this.history(c, task.sessionId, signal),
        approval: null,
        error: null,
      };
    }
  }
  async steer(c: AgentConnection, task: AgentTask, message: string, signal?: AbortSignal) {
    await this.request(c, '/v1/runs/' + task.runId + '/steer', { input: message }, signal);
  }
  async stop(c: AgentConnection, task: AgentTask, signal?: AbortSignal) {
    await this.request(c, '/v1/runs/' + task.runId + '/stop', {}, signal);
  }
  async approve(
    c: AgentConnection,
    task: AgentTask,
    requestId: string,
    choice: 'once' | 'deny',
    signal?: AbortSignal,
  ) {
    await this.request(
      c,
      '/v1/runs/' + task.runId + '/approval',
      { request_id: requestId, choice },
      signal,
    );
  }
}
