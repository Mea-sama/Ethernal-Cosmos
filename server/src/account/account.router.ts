import { Router } from 'express';
import { requireAuth } from '../auth/auth.middleware';
import { HubError, isHubError, sendHubError } from '../errors';
import { assertUserLimit } from '../social/bus';
import { exportAccount } from './account.service';

const accountRouter = Router();
accountRouter.use(requireAuth);

/** GET /account/export — alle über den User gespeicherten Daten als JSON-Download */
accountRouter.get('/export', async (req, res): Promise<void> => {
  try {
    assertUserLimit(req.auth!.userId, 'accountExport');
    const body = await exportAccount(req.auth!.userId);
    res.setHeader('Content-Disposition', 'attachment; filename="ethernal-account-export.json"');
    res.json(body);
  } catch (err) {
    if (isHubError(err)) return sendHubError(res, err);
    console.error('[Account] Export fehlgeschlagen:', err);
    sendHubError(res, new HubError('INTERNAL'));
  }
});

export { accountRouter };
