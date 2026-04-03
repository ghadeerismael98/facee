import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) {
    next();
    return;
  }

  const key = req.headers['x-api-key'] as string;
  if (!key || !timingSafeCompare(key, config.apiKey)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
