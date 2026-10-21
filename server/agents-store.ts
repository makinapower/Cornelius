import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentConnectionView,
  AgentDiscovery,
  AgentKind,
  AgentTaskStatus,
} from '../shared/agents.js';
import type { Scope } from '../shared/types.js';

export const agentsMigration = `
CREATE TABLE agent_connections (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE, url TEXT NOT NULL, token TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  description TEXT NOT NULL, revision INTEGER NOT NULL, discovery TEXT
) STRICT;
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  run_id TEXT, session_id TEXT NOT NULL, scope TEXT NOT NULL, call_id TEXT NOT NULL,
  persistent INTEGER NOT NULL CHECK(persistent IN (0,1)), status TEXT NOT NULL, delivered_status TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(connection_id,call_id)
) STRICT;
CREATE INDEX agent_tasks_owner ON agent_tasks(profile_id,created_at);
`;
/** Type d’agent de chaque connexion ; sans ligne, Hermes (connexions d’avant opencode). */
export const agentKindMigration = `CREATE TABLE IF NOT EXISTS agent_connection_kinds (
  profile_id TEXT PRIMARY KEY REFERENCES agent_connections(profile_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('hermes', 'opencode'))
) STRICT;`;
export interface AgentConnection extends AgentConnectionView {
  id: string;
  token: string;
}
export interface AgentTask {
  id: string;
  connectionId: string;
  profileId: string;
  runId: string | null;
  sessionId: string;
  scope: Scope;
  callId: string;
  persistent: boolean;
  status: AgentTaskStatus;
  createdAt: number;
  updatedAt: number;
  deliveredStatus: string | null;
}
export class AgentRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now = Date.now,
  ) {}
  hasProfile(id: string) {
    return !!this.db.prepare('SELECT id FROM profiles WHERE id=?').get(id);
  }
  get(profileId: string): AgentConnection | null {
    const r = this.db
      .prepare(
        `SELECT c.*, k.kind FROM agent_connections c
        LEFT JOIN agent_connection_kinds k ON k.profile_id = c.profile_id WHERE c.profile_id=?`,
      )
      .get(profileId);
    return r
      ? {
          id: String(r.id),
          profileId,
          kind: (String(r.kind ?? 'hermes') === 'opencode' ? 'opencode' : 'hermes') as AgentKind,
          url: String(r.url),
          token: String(r.token),
          hasToken: !!r.token,
          enabled: !!r.enabled,
          description: String(r.description),
          revision: Number(r.revision),
          discovery: r.discovery ? (JSON.parse(String(r.discovery)) as AgentDiscovery) : null,
        }
      : null;
  }
  save(
    profileId: string,
    input: {
      kind?: AgentKind;
      url: string;
      token: string;
      enabled: boolean;
      description: string;
      revision: number;
    },
  ) {
    const current = this.get(profileId);
    if (!this.hasProfile(profileId)) throw new Error('Profil introuvable.');
    if ((current?.revision ?? 0) !== input.revision)
      throw new Error('Configuration modifiée : actualisez la page.');
    this.db
      .prepare(
        `INSERT INTO agent_connections(profile_id,id,url,token,enabled,description,revision)
      VALUES(?,?,?,?,?,?,1) ON CONFLICT(profile_id) DO UPDATE SET
      url=excluded.url,token=excluded.token,enabled=excluded.enabled,description=excluded.description,
      discovery=NULL,revision=agent_connections.revision+1`,
      )
      .run(
        profileId,
        current?.id ?? randomUUID(),
        input.url,
        input.token,
        Number(input.enabled),
        input.description,
      );
    this.db
      .prepare(
        `INSERT INTO agent_connection_kinds(profile_id,kind) VALUES(?,?)
        ON CONFLICT(profile_id) DO UPDATE SET kind=excluded.kind`,
      )
      .run(profileId, input.kind ?? 'hermes');
    return this.get(profileId)!;
  }
  discovery(c: AgentConnection, result: AgentDiscovery) {
    return !!this.db
      .prepare('UPDATE agent_connections SET discovery=? WHERE id=? AND revision=?')
      .run(JSON.stringify(result), c.id, c.revision).changes;
  }
  listConnections() {
    return this.db
      .prepare('SELECT profile_id FROM agent_connections')
      .all()
      .map((r) => this.get(String(r.profile_id))!);
  }
  remove(id: string) {
    this.db.prepare('DELETE FROM agent_connections WHERE profile_id=?').run(id);
  }
  private task(r: Record<string, unknown>): AgentTask {
    return {
      id: String(r.id),
      connectionId: String(r.connection_id),
      profileId: String(r.profile_id),
      runId: r.run_id ? String(r.run_id) : null,
      sessionId: String(r.session_id),
      scope: JSON.parse(String(r.scope)) as Scope,
      callId: String(r.call_id),
      persistent: !!r.persistent,
      status: String(r.status) as AgentTaskStatus,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      deliveredStatus: r.delivered_status ? String(r.delivered_status) : null,
    };
  }
  tasks(profileId: string) {
    return this.db
      .prepare(
        'SELECT * FROM agent_tasks WHERE profile_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100',
      )
      .all(profileId)
      .map((r) => this.task(r));
  }
  find(id: string) {
    const r = this.db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(id);
    return r ? this.task(r) : null;
  }
  create(
    c: AgentConnection,
    scope: Scope,
    callId: string,
    persistent: boolean,
    sessionId?: string,
  ) {
    const duplicate = this.db
      .prepare('SELECT * FROM agent_tasks WHERE connection_id=? AND call_id=?')
      .get(c.id, callId);
    if (duplicate) return this.task(duplicate);
    const tasks = this.tasks(c.profileId);
    if (tasks.length >= 100) {
      const oldest = [...tasks]
        .reverse()
        .find((t) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(t.status));
      if (!oldest) throw new Error('Trop de tâches en cours.');
      this.forget(oldest.id);
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO agent_tasks(id,connection_id,profile_id,run_id,session_id,scope,call_id,persistent,status,created_at,updated_at)
      VALUES(?,?,?,NULL,?,?,?,?,'submitting',?,?)`,
      )
      .run(
        id,
        c.id,
        c.profileId,
        sessionId ?? `cornelius-${randomUUID()}`,
        JSON.stringify(scope),
        callId,
        Number(persistent),
        this.now(),
        this.now(),
      );
    return this.find(id)!;
  }
  update(id: string, status: AgentTaskStatus, runId?: string) {
    this.db
      .prepare('UPDATE agent_tasks SET status=?,run_id=COALESCE(?,run_id),updated_at=? WHERE id=?')
      .run(status, runId ?? null, this.now(), id);
    return this.find(id);
  }
  delivered(id: string, stamp: string) {
    this.db.prepare('UPDATE agent_tasks SET delivered_status=? WHERE id=?').run(stamp, id);
  }
  forget(id: string) {
    this.db.prepare('DELETE FROM agent_tasks WHERE id=?').run(id);
  }
}
