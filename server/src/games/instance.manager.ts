import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getGame } from './game.registry';
import { lobbyManager } from '../lobby/lobby.manager';
import { getAllOwnAsRecord } from '../user-data/userdata.service';
import type { Lobby, IpcHubToGame, IpcGameToHub } from '@ethernal/shared';

/** Callback-Typ: wird aufgerufen wenn der Subprocess eine IPC-Nachricht sendet */
type IpcMessageCallback = (lobbyId: string, msg: IpcGameToHub) => void;

interface RunningInstance {
  lobbyId: string;
  gameId: string;
  process: ChildProcess;
  startedAt: number;
}

class InstanceManager {
  private instances = new Map<string, RunningInstance>();
  private onMessage?: IpcMessageCallback;

  // ─── IPC-Callback registrieren ───────────────────────────────────────────

  setMessageCallback(cb: IpcMessageCallback): void {
    this.onMessage = cb;
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

    const scriptPath = path.resolve(__dirname, '../../..', game.entryScript);

    // Verzeichnis für die spiel-eigene DB anlegen und Pfad übergeben
    const gameDataDir = path.resolve(__dirname, '../../../data/games', game.id);
    if (!fs.existsSync(gameDataDir)) {
      fs.mkdirSync(gameDataDir, { recursive: true });
    }
    const gameDbPath = path.join(gameDataDir, `${game.id}.db`).replace(/\\/g, '/');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GAME_ID: lobby.gameId,
      LOBBY_ID: lobby.id,
      GAME_DB_PATH: `file:${gameDbPath}`,
      LOBBY_SETTINGS: JSON.stringify(lobby.settings),
      PLAYERS: JSON.stringify(
        lobby.players.map((p) => ({ userId: p.userId, username: p.username }))
      ),
    };

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
      const msg = raw as IpcGameToHub;
      // GET_USER_DATA wird direkt hier behandelt, kein Callback nötig
      if (msg.type === 'GET_USER_DATA') {
        const { requestId, userId, gameId } = msg.payload;
        getAllOwnAsRecord(userId, gameId)
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
      this.onMessage?.(lobby.id, msg);
    });

    child.on('exit', (code) => {
      console.log(`[InstanceManager] Lobby ${lobby.id} beendet (exit ${code ?? '?'})`);
      this.instances.delete(lobby.id);
      lobbyManager.setStatus(lobby.id, 'closed');
    });

    child.on('error', (err) => {
      console.error(`[InstanceManager] Subprocess-Fehler (${lobby.id}):`, err.message);
      this.instances.delete(lobby.id);
      lobbyManager.setStatus(lobby.id, 'closed');
    });

    this.instances.set(lobby.id, {
      lobbyId: lobby.id,
      gameId: lobby.gameId,
      process: child,
      startedAt: Date.now(),
    });

    console.log(`[InstanceManager] "${game.name}" gestartet für Lobby ${lobby.id}`);
  }

  // ─── Nachricht an Subprocess senden ──────────────────────────────────────

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
    if (!inst) return;
    inst.process.kill('SIGTERM');
  }

  isRunning(lobbyId: string): boolean {
    return this.instances.has(lobbyId);
  }
}

// Singleton
export const instanceManager = new InstanceManager();
