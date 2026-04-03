/**
 * Profile management API routes.
 * Exposes Vela profiles and group-to-profile mappings.
 */
import { Router } from 'express';
import { campaignRunner, storage } from '../server';

export const profileRouter = Router();

// GET /api/profiles — list all Vela profiles
profileRouter.get('/', async (_req, res) => {
  try {
    const profiles = await campaignRunner.profileManager.listProfiles();
    res.json({ profiles });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/profiles/selected — get selected profile IDs for campaigns
profileRouter.get('/selected', async (_req, res) => {
  try {
    const selected = await campaignRunner.profileManager.getSelectedProfiles();
    res.json({ profileIds: selected });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/profiles/selected — set selected profile IDs
profileRouter.post('/selected', async (req, res) => {
  try {
    const { profileIds } = req.body;
    await campaignRunner.profileManager.setSelectedProfiles(profileIds || []);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/profiles/group-mappings — get per-profile group assignments
profileRouter.get('/group-mappings', async (_req, res) => {
  try {
    const mappings = await campaignRunner.profileManager.getProfileGroups();
    res.json({ mappings });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/profiles/group-mappings — save per-profile group assignments
profileRouter.post('/group-mappings', async (req, res) => {
  try {
    const { mappings } = req.body;
    await campaignRunner.profileManager.saveProfileGroups(mappings || []);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
