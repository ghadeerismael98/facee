import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) {
    next();
    return;
  }

  const key = req.headers['x-api-key'] as string;
  if (!key || key !== config.apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
