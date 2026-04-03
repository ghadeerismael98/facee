import 'dotenv/config';
import express from 'express';
import { config } from './config';
import { authMiddleware } from './middleware/auth';
import { browserManager } from './browser/manager';
import { contextManager } from './browser/context-manager';
import statusRoutes from './routes/status';
import tabRoutes from './routes/tabs';
import profileRoutes from './routes/profiles';
import windowRoutes from './routes/windows';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(authMiddleware);

app.use(statusRoutes);
app.use(tabRoutes);
app.use(profileRoutes);
app.use(windowRoutes);

async function start() {
  await browserManager.launch();

  // Auto-save cookies every 60 seconds
  setInterval(() => contextManager.saveAllState(), 60000);

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Ghost Browser API running on port ${config.port}`);
  });
}

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  await contextManager.closeAll();
  await browserManager.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(console.error);
