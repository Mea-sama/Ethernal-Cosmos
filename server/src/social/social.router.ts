import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../auth/auth.middleware';
import { HubError, isHubError, sendHubError } from '../errors';
import { runAction, type ActionName } from './actions';
import { purgeUserSocialData } from './sync.service';

export const socialRouter = Router();
socialRouter.use(requireAuth);

function route(
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  name: ActionName,
  input: (req: Request) => unknown,
  status = 200,
): void {
  socialRouter[method](path, async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await runAction(name, req.auth!.userId, input(req));
      if (name === 'social:sync' && 'notModified' in result && req.headers['if-none-match'] === result.etag) {
        res.status(304).end();
        return;
      }
      res.status(status).json(result);
    } catch (err) {
      if (isHubError(err)) {
        if (err.retryAfterMs !== undefined) res.setHeader('Retry-After', Math.ceil(err.retryAfterMs / 1000));
        sendHubError(res, err);
        return;
      }
      console.error(`[Social] ${method.toUpperCase()} ${path} Fehler:`, err);
      sendHubError(res, new HubError('INTERNAL'));
    }
  });
}

const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' ? req.body : {});

route('get', '/sync', 'social:sync', (req) => ({ etag: req.query.etag ?? req.headers['if-none-match'] }));

route('get', '/friends', 'friend:list', () => undefined);
route('post', '/friends/requests', 'friend:request', (req) => body(req));
route('get', '/friends/requests', 'friend:requests', () => undefined);
route('post', '/friends/requests/:id/respond', 'friend:respond', (req) => ({ requestId: req.params.id, accept: body(req).accept }));
route('delete', '/friends/requests/:id', 'friend:cancel', (req) => ({ requestId: req.params.id }));
route('get', '/friends/:id/lobby', 'social:friendLobby', (req) => ({ friendId: req.params.id }));
route('delete', '/friends/:id', 'friend:remove', (req) => ({ friendId: req.params.id }));

route('get', '/presence', 'presence:friends', () => undefined);
route('get', '/settings', 'social:getSettings', () => undefined);
route('put', '/settings', 'social:setSettings', (req) => body(req));
route('put', '/status', 'social:setSettings', (req) => ({ status: body(req).status }));

route('get', '/notifications', 'notification:list', (req) => req.query);
route('post', '/notifications/read', 'notification:markRead', (req) => body(req));
route('get', '/notifications/counts', 'notification:counts', () => undefined);

route('get', '/dm', 'dm:conversations', () => undefined);
route('post', '/dm/:id', 'dm:send', (req) => ({ toUserId: req.params.id, text: body(req).text }), 201);
route('get', '/dm/:id', 'dm:history', (req) => ({ withUserId: req.params.id, before: req.query.before, limit: req.query.limit }));
route('post', '/dm/:id/read', 'dm:markRead', (req) => ({ withUserId: req.params.id }));

route('get', '/lobby-invites', 'lobby:invites', () => undefined);

/** Löscht alle eigenen Social-Daten (Freunde, Nachrichten, Notifications, Einstellungen). */
socialRouter.delete('/data', async (req: Request, res: Response): Promise<void> => {
  try {
    await purgeUserSocialData(req.auth!.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Social] DELETE /data Fehler:', err);
    sendHubError(res, new HubError('INTERNAL'));
  }
});
