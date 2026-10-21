import type { AgentDiscovery, AgentTaskView } from '../shared/agents.js';
import type { AgentConnection, AgentTask } from './agents-store.js';

/** État d’une tâche lu chez l’agent. */
export type AgentRunState = Pick<AgentTaskView, 'status' | 'output' | 'approval' | 'error'>;

/**
 * Ce que Cornelius demande à un agent (Hermes, opencode). L’agent garde l’exécution, ses
 * permissions et la vie de ses tâches ; Cornelius garde la connexion et les références.
 */
export interface AgentBackend {
  discover(c: AgentConnection, signal?: AbortSignal): Promise<AgentDiscovery>;
  /**
   * Envoie une demande ; rend l’identifiant distant de la tâche. `previous` est la dernière
   * tâche de la même conversation quand la personne poursuit une demande terminée.
   */
  submit(
    c: AgentConnection,
    task: AgentTask,
    message: string,
    previous: AgentTask | null,
    signal: AbortSignal,
  ): Promise<string>;
  /** `latest` : la tâche est la plus récente de sa conversation. */
  status(
    c: AgentConnection,
    task: AgentTask,
    latest: boolean,
    signal?: AbortSignal,
  ): Promise<AgentRunState>;
  /** Précision pendant le travail (ou réponse à une question de l’agent). */
  steer(c: AgentConnection, task: AgentTask, message: string, signal?: AbortSignal): Promise<void>;
  stop(c: AgentConnection, task: AgentTask, signal?: AbortSignal): Promise<void>;
  approve(
    c: AgentConnection,
    task: AgentTask,
    requestId: string,
    choice: 'once' | 'deny',
    signal?: AbortSignal,
  ): Promise<void>;
}
