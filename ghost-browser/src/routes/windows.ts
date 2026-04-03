import { Router, Request, Response } from 'express';
import { contextManager } from '../browser/context-manager';
import { tabManager } from '../browser/tab-manager';

const router = Router();

function buildWindowResponse(profileId: string) {
  const tabCount = tabManager.getTabsByProfile(profileId).length;
  return {
    id: `window-${profileId}`,
    tabCount,
    profileId,
    isPrivate: false,
  };
}

router.get('/api/windows', (_req, res) => {
  const profileIds = contextManager.getActiveProfileIds();
  const windows = profileIds.map(buildWindowResponse);
  res.json(windows);
});

router.post('/api/windows', async (req: Request, res: Response) => {
  try {
    const profileId = req.body.profileId || 'default';
    await contextManager.getOrCreate(profileId);
    res.json(buildWindowResponse(profileId));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/windows/:id', async (req: Request, res: Response) => {
  try {
    // Window ID format: "window-{profileId}"
    const profileId = req.params.id.replace(/^window-/, '');
    await contextManager.destroyContext(profileId);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
