import { Router } from 'express';
import { profileStorage, getProfileId } from '../server';

export const storageRouter = Router();

// GET /api/storage/:area?keys=key1,key2
storageRouter.get('/:area', async (req, res) => {
  try {
    const { area } = req.params;
    const keysParam = req.query.keys as string | undefined;
    const keys = keysParam ? keysParam.split(',') : undefined;
    const storage = profileStorage.getStorage(getProfileId(req));
    const data = await storage.get(area, keys);
    res.json(data);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/storage/:area — set items
storageRouter.post('/:area', async (req, res) => {
  try {
    const { area } = req.params;
    const storage = profileStorage.getStorage(getProfileId(req));
    await storage.set(area, req.body);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/storage/:area — remove keys
storageRouter.delete('/:area', async (req, res) => {
  try {
    const { area } = req.params;
    const { keys } = req.body;
    const storage = profileStorage.getStorage(getProfileId(req));
    if (keys) {
      await storage.remove(area, keys);
    } else {
      await storage.clear(area);
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
