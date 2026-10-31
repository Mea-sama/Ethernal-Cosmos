import type { Socket } from 'socket.io';
import { HubError, isHubError } from '../errors';
import { actions, runAction, type ActionName } from './actions';
import { setSocialIo, type SocialServer } from './bus';
import { markDelivered } from './messages.service';
import './invites.service';
import { backlog } from './notifications.service';
import { presenceChanged } from './presence.service';
import { loadSettings } from './settings.service';

type AnyAck = (result: unknown) => void;

/** Aktionen, deren Fehler ohne Ack nicht als `error`-Event gemeldet werden (hochfrequent/ephemer) */
const QUIET: ActionName[] = ['dm:typing'];

/** Registriert alle Social-Events (Freunde, Presence, Notifications, DMs, Lobby-Einladungen). Nach registerLobbyHandlers aufrufen. */
export function registerSocialHandlers(io: SocialServer): void {
  setSocialIo(io);

  io.on('connection', (socket: Socket) => {
    const { userId } = socket.data as { userId: string };

    for (const name of Object.keys(actions) as ActionName[]) {
      socket.on(name, async (...args: unknown[]) => {
        const ack = typeof args[args.length - 1] === 'function' ? (args.pop() as AnyAck) : undefined;
        const data = args[0];
        const requestId =
          data && typeof data === 'object' && typeof (data as { requestId?: unknown }).requestId === 'string'
            ? (data as { requestId: string }).requestId.slice(0, 64)
            : undefined;
        try {
          const result = await runAction(name, userId, data);
          ack?.({ ok: true, ...result });
        } catch (err) {
          let hubErr: HubError;
          if (isHubError(err)) hubErr = err;
          else {
            console.error(`[Social] ${name} Fehler:`, err);
            hubErr = new HubError('INTERNAL');
          }
          const payload = hubErr.toPayload({ event: name, requestId });
          if (ack) ack({ ok: false, error: payload });
          else if (!QUIET.includes(name)) {
            socket.emit('error', hubErr.message);
            socket.emit('errorDetail', payload);
          }
        }
      });
    }

    // Verbindungsaufbau/Resume: Settings laden, Presence verteilen, Backlog + zugestellte DMs
    void (async () => {
      try {
        await loadSettings(userId, true);
        presenceChanged(userId);
        socket.emit('notification:backlog', await backlog(userId));
        await markDelivered(userId);
      } catch (err) {
        console.error('[Social] Connect-Initialisierung fehlgeschlagen:', err);
      }
    })();

    socket.on('disconnect', () => presenceChanged(userId));
  });
}
