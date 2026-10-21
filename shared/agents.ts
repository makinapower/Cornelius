/** The agent owns execution; Cornelius keeps only connection settings and task references. */

/** Agent relié à une personne : Hermes (Nous Research) ou opencode (agent de code). */
export type AgentKind = 'hermes' | 'opencode';
export const AGENT_KINDS: readonly AgentKind[] = ['hermes', 'opencode'];
export const agentKindLabels: Record<AgentKind, string> = {
  hermes: 'Hermes',
  opencode: 'opencode',
};
/** Les textes sont écrits pour Hermes : un autre agent y est nommé à sa place. */
export function agentText(text: string, kind: AgentKind | undefined): string {
  return kind && kind !== 'hermes' ? text.replaceAll('Hermes', agentKindLabels[kind]) : text;
}
export interface AgentCapability {
  name: string;
  description: string;
  kind: 'toolset' | 'skill';
  tools: string[];
}

export interface AgentDiscovery {
  checkedAt: number;
  available: boolean;
  error: string | null;
  capabilities: AgentCapability[];
  catalogComplete: boolean;
  issues?: { kind: 'toolset' | 'skill'; message: string }[];
  approval: boolean;
  steer: boolean;
}

export interface AgentConnectionInput {
  /** Hermes si absent (anciennes administrations). */
  kind?: AgentKind;
  url: string;
  token?: string;
  enabled: boolean;
  description: string;
  revision: number;
}

export interface AgentConnectionView {
  profileId: string;
  kind: AgentKind;
  url: string;
  hasToken: boolean;
  enabled: boolean;
  description: string;
  revision: number;
  discovery: AgentDiscovery | null;
}

export type AgentTaskStatus =
  | 'submitting'
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown';

export interface AgentApproval {
  id: string;
  description: string;
}

export interface AgentTaskView {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: AgentTaskStatus;
  persistent: boolean;
  output: string | null;
  approval: AgentApproval | null;
  error: string | null;
}

export interface AgentAdminView {
  connection: AgentConnectionView;
  tasks: AgentTaskView[];
}

export const agentTaskLabels: Record<AgentTaskStatus, string> = {
  submitting: 'Envoi en cours',
  queued: 'En attente',
  running: 'En cours',
  waiting_for_approval: 'Accord demandé par l’agent',
  stopping: 'Arrêt demandé',
  completed: 'Terminée',
  failed: 'Échec',
  cancelled: 'Annulée',
  interrupted: 'Interrompue',
  unknown: 'État à vérifier',
};
