import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getGame } from './game.registry';
import { lobbyManager } from '../lobby/lobby.manager';
import { applyOps, getAllOwnAsRecord, type DataOp } from '../user-data/userdata.service';
import { OpsSchema, GameIdSchema, KeySchema, VisibilitySchema } from '../user-data/userdata.schemas';
import { HubError, isHubError } from '../errors';
import { z } from 'zod';
import { DATA_DIR } from '../config/env';
import type { Lobby, IpcHubToGame, IpcGameToHub } from '@ethernal/shared';

/** Callback-Typ: wird aufgerufen wenn der Subprocess eine IPC-Nachricht sendet */
type IpcMessageCallback = (lobbyId: string, msg: IpcGameToHub) => void;

interface RunningInstance {
  lobbyId: string;
  gameId: string;
  process: ChildProcess;
  startedAt: number;
  /** true, wenn der Hub den Prozess selbst beendet hat (kein Crash) */
  stopping: boolean;
}

/** Callback: Subprocess hat sich unerwartet beendet (Crash / Exit ohne stopInstance) */
type ExitCallback = (lobbyId: string, code: number | null, alreadyClosed: boolean) => void;

const MAX_INSTANCES = Number(process.env.MAX_INSTANCES) || 50;
const KILL_TIMEOUT_MS = Number(process.env.INSTANCE_KILL_TIMEOUT_MS) || 5000;
/** Nur diese Variablen des Hub-Prozesses werden an Subprocesses weitergereicht (nie JWT_SECRET o.ä.) */
const ENV_WHITELIST = ['PATH', 'NODE_ENV', 'HOME', 'TZ', 'LANG', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP'];

class InstanceManager {
  private instances = new Map<string, RunningInstance>();
  private onMessage?: IpcMessageCallback;
  private onExit?: ExitCallback;

  // ─── IPC-Callback registrieren ───────────────────────────────────────────

  setMessageCallback(cb: IpcMessageCallback): void {
    this.onMessage = cb;
  }

  setExitCallback(cb: ExitCallback): void {
    this.onExit = cb;
  }

  // ─── Instanz starten ─────────────────────────────────────────────────────

  /**
   * Spawnt den Game-Subprocess für die angegebene Lobby via IPC.
   * Spielkommunikation läuft über den Hub – kein eigener Port nötig.
   */
  async startInstance(lobby: Lobby): Promise<void> {
    if (this.instances.has(lobby.id)) {
      throw new Error('INSTANCE_ALREADY_RUNNING');
    }

    const game = getGame(lobby.gameId);
    if (!game) throw new Error('GAME_NOT_FOUND');

    // Kein entryScript → reines Relay-Spiel, kein Subprocess nötig
    if (!game.entryScript) return;

    if (this.instances.size >= MAX_INSTANCES) throw new HubError('INSTANCE_LIMIT');

    const scriptPath = path.resolve(__dirname, '../../..', game.entryScript);
    if (!fs.existsSync(scriptPath)) throw new Error('GAME_SCRIPT_MISSING');

    // Verzeichnis für die spiel-eigene DB anlegen und Pfad übergeben
    const gameDataDir = path.join(DATA_DIR, 'games', game.id);
    if (!fs.existsSync(gameDataDir)) {
      fs.mkdirSync(gameDataDir, { recursive: true });
    }
    const gameDbPath = path.join(gameDataDir, `${game.id}.db`).replace(/\\/g, '/');

    const env: NodeJS.ProcessEnv = {};
    for (const key of [...ENV_WHITELIST, ...(game.envPassthrough ?? [])]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, {
      GAME_ID: lobby.gameId,
      LOBBY_ID: lobby.id,
      GAME_DB_PATH: `file:${gameDbPath}`,
      LOBBY_SETTINGS: JSON.stringify(lobby.settings),
      PLAYERS: JSON.stringify(
        lobby.players.map((p) => ({ userId: p.userId, username: p.username }))
      ),
    });

    // stdio[3] = 'ipc' aktiviert process.send() / process.on('message') im Child
    const child = spawn('node', [scriptPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    const tag = `${lobby.gameId}:${lobby.id.slice(0, 8)}`;

    child.stdout?.on('data', (d: Buffer) =>
      console.log(`[${tag}] ${d.toString().trim()}`)
    );
    child.stderr?.on('data', (d: Buffer) =>
      console.error(`[${tag}] ERR: ${d.toString().trim()}`)
    );

    child.on('message', (raw: unknown) => {
      // Ein fehlerhafter Subprocess darf den Hub nie zum Absturz bringen
      try {
        this.handleChildMessage(lobby, raw);
      } catch (err) {
        console.error(`[IPC] Ungültige Nachricht von Lobby ${lobby.id} verworfen:`, err);
      }
    });

    const instance: RunningInstance = {
      lobbyId: lobby.id,
      gameId: lobby.gameId,
      process: child,
      startedAt: Date.now(),
      stopping: false,
    };
    this.instances.set(lobby.id, instance);

    child.on('exit', (code) => {
      console.log(`[InstanceManager] Lobby ${lobby.id} beendet (exit ${code ?? '?'})`);
      if (this.instances.get(lobby.id) === instance) this.instances.delete(lobby.id);
      if (!instance.stopping) {
        // Ein Prozess, der nach GAME_OVER regulär endet, ist kein Absturz
        const alreadyClosed = lobbyManager.getLobby(lobby.id)?.status === 'closed';
        lobbyManager.setStatus(lobby.id, 'closed');
        this.onExit?.(lobby.id, code, alreadyClosed);
      }
    });

    // Spawn-Fehler (z.B. ENOENT/EMFILE) kommen asynchron: erst auf 'spawn' warten, damit Start-Fehler den Rollback auslösen
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (err) => {
        console.error(`[InstanceManager] Subprocess-Fehler (${lobby.id}):`, err.message);
        if (this.instances.get(lobby.id) === instance) this.instances.delete(lobby.id);
        reject(err);
      });
    });
    child.on('error', (err) => console.error(`[InstanceManager] Subprocess-Fehler (${lobby.id}):`, err.message));

    this.sendToInstance(lobby.id, {
      type: 'INIT',
      payload: {
        lobbyId: lobby.id,
        gameId: lobby.gameId,
        settings: lobby.settings,
        players: lobby.players.map((p) => ({ userId: p.userId, username: p.username })),
      },
    });

    console.log(`[InstanceManager] "${game.name}" gestartet für Lobby ${lobby.id}`);
  }

  // ─── Nachricht an Subprocess senden ──────────────────────────────────────

  private handleChildMessage(lobby: Lobby, raw: unknown): void {
    if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return;
    const msg = raw as IpcGameToHub;
    // GET_USER_DATA wird direkt hier behandelt, kein Callback nötig
    if (msg.type === 'GET_USER_DATA') {
      const { requestId, userId, gameId } = msg.payload;
      // Nur Daten von Teilnehmern dieser Lobby und nur für das Spiel der Lobby herausgeben
      const allowed = lobbyManager.isParticipant(lobby.id, gameId, userId);
      if (!allowed) console.warn(`[IPC] GET_USER_DATA abgelehnt (${userId}/${gameId}) in Lobby ${lobby.id}`);
      (allowed ? getAllOwnAsRecord(userId, gameId) : Promise.resolve({} as Record<string, unknown>))
        .then((data) => {
          this.sendToInstance(lobby.id, {
            type: 'USER_DATA_RESPONSE',
            payload: { requestId, userId, gameId, data },
          });
        })
        .catch((err) =>
          console.error(`[IPC] GET_USER_DATA fehlgeschlagen (${userId}/${gameId}):`, err)
        );
      return;
    }
    if (msg.type === 'INCREMENT_USER_DATA' || msg.type === 'SET_USER_DATA_IF' || msg.type === 'TRANSACT_USER_DATA') {
      this.handleDataOp(lobby, msg);
      return;
    }
    this.onMessage?.(lobby.id, msg);
  }

  /** Atomare Daten-Operationen des Subprocess (server-vertraut, nur für Teilnehmer der Lobby und ihr Spiel). */
  private handleDataOp(lobby: Lobby, msg: Extract<IpcGameToHub, { type: 'INCREMENT_USER_DATA' | 'SET_USER_DATA_IF' | 'TRANSACT_USER_DATA' }>): void {
    const requestId = typeof msg.payload?.requestId === 'string' ? msg.payload.requestId : '';
    const respond = (payload: Extract<IpcHubToGame, { type: 'USER_DATA_OP_RESPONSE' }>['payload']): void =>
      this.sendToInstance(lobby.id, { type: 'USER_DATA_OP_RESPONSE', payload });
    const run = async (): Promise<void> => {
      const base = z.object({ requestId: z.string(), userId: z.string().min(1).max(64), gameId: GameIdSchema });
      const { userId, gameId } = base.passthrough().parse(msg.payload);
      if (!lobbyManager.isParticipant(lobby.id, gameId, userId)) {
        console.warn(`[IPC] ${msg.type} abgelehnt (${userId}/${gameId}) in Lobby ${lobby.id}`);
        throw new HubError('NOT_ALLOWED');
      }
      let ops: DataOp[];
      if (msg.type === 'INCREMENT_USER_DATA') {
        const p = z.object({ key: KeySchema, by: z.number().finite(), visibility: VisibilitySchema.optional() }).parse(msg.payload);
        ops = [{ op: 'increment', ...p }];
      } else if (msg.type === 'SET_USER_DATA_IF') {
        const p = z.object({ key: KeySchema, value: z.unknown(), expectedVersion: z.number().int().min(0), visibility: VisibilitySchema.optional() }).parse(msg.payload);
        ops = [{ op: 'setIf', ...p }];
      } else {
        ops = z.object({ ops: OpsSchema }).parse(msg.payload).ops;
      }
      respond({ requestId, ok: true, results: await applyOps(userId, gameId, ops, 'server', { writtenBy: 'subprocess' }) });
    };
    run().catch((err) => {
      const e = isHubError(err) ? err : err instanceof z.ZodError ? new HubError('INVALID_INPUT') : new HubError('INTERNAL');
      if (e.code === 'INTERNAL') console.error(`[IPC] ${msg.type} fehlgeschlagen:`, err);
      respond({ requestId, ok: false, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } });
    });
  }

  sendToInstance(lobbyId: string, msg: IpcHubToGame): void {
    const inst = this.instances.get(lobbyId);
    if (!inst) return;
    try {
      inst.process.send(msg);
    } catch (err) {
      console.error(`[InstanceManager] IPC send fehlgeschlagen (${lobbyId}):`, err);
    }
  }

  // ─── Instanz stoppen ─────────────────────────────────────────────────────

  stopInstance(lobbyId: string): void {
    const inst = this.instances.get(lobbyId);
    if (!inst || inst.stopping) return;
    inst.stopping = true;
    this.instances.delete(lobbyId);
    inst.process.kill('SIGTERM');
    const killer = setTimeout(() => {
      if (inst.process.exitCode === null && inst.process.signalCode === null) inst.process.kill('SIGKILL');
    }, KILL_TIMEOUT_MS);
    killer.unref();
    inst.process.once('exit', () => clearTimeout(killer));
  }

  /** Beendet alle Instanzen (Server-Shutdown) */
  stopAll(): void {
    for (const id of [...this.instances.keys()]) this.stopInstance(id);
  }

  count(): number {
    return this.instances.size;
  }

  isRunning(lobbyId: string): boolean {
    return this.instances.has(lobbyId);
  }
}

// Singleton
export const instanceManager = new InstanceManager();
