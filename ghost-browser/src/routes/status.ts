import { Router } from 'express';
import { tabManager } from '../browser/tab-manager';
import { contextManager } from '../browser/context-manager';

const router = Router();
const startTime = Date.now();

router.get('/api/status', (_req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  res.json({
    version: '1.0.0',
    uptime,
    windows: contextManager.getContextCount(),
    tabs: tabManager.getTabCount(),
  });
});

export default router;
