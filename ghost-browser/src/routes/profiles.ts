import { Router, Request, Response } from 'express';
import { profileStore } from '../profiles/store';
import { contextManager } from '../browser/context-manager';

const router = Router();

router.get('/api/profiles', (_req, res) => {
  res.json(profileStore.list());
});

router.get('/api/profiles/:id', (req: Request, res: Response) => {
  const profile = profileStore.get(req.params.id);
  if (!profile) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }
  res.json(profile);
});

router.post('/api/profiles', (req: Request, res: Response) => {
  try {
    const profile = profileStore.create(req.body);
    res.status(201).json(profile);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/api/profiles/:id', (req: Request, res: Response) => {
  const profile = profileStore.update(req.params.id, req.body);
  if (!profile) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }
  res.json(profile);
});

router.delete('/api/profiles/:id', async (req: Request, res: Response) => {
  try {
    await contextManager.destroyContext(req.params.id);
    const deleted = profileStore.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/profiles/:id/activate', async (req: Request, res: Response) => {
  try {
    await contextManager.getOrCreate(req.params.id);
    res.json({ success: true, profileId: req.params.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
