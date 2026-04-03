import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

interface TorInstance {
  process: ChildProcess;
  socksPort: number;
  controlPort: number;
  dataDir: string;
  profileId: string;
  exitIp?: string;
  ready: boolean;
}

const instances = new Map<string, TorInstance>();

function findTorBinary(): string {
  const paths = [
    '/opt/homebrew/bin/tor',
    '/opt/homebrew/opt/tor/bin/tor',
    '/usr/local/bin/tor',
    '/usr/bin/tor',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return 'tor'; // hope it's in PATH
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => { server.close(); resolve(true); });
      server.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error('No free ports found');
}

export const torManager = {
  async start(profileId: string): Promise<{ socksPort: number; exitIp?: string }> {
    // Already running for this profile
    const existing = instances.get(profileId);
    if (existing?.ready) {
      return { socksPort: existing.socksPort, exitIp: existing.exitIp };
    }

    // Find free ports
    const basePort = 9150 + instances.size * 2;
    const socksPort = await findFreePort(basePort);
    const controlPort = await findFreePort(socksPort + 1);

    // Create temp data directory
    const dataDir = path.join(os.tmpdir(), `ghost-tor-${profileId.slice(0, 8)}-${Date.now()}`);
    fs.mkdirSync(dataDir, { recursive: true });

    // Write torrc
    const torrc = path.join(dataDir, 'torrc');
    fs.writeFileSync(torrc, [
      `SocksPort ${socksPort}`,
      `ControlPort ${controlPort}`,
      `DataDirectory ${dataDir}/data`,
      'ClientOnly 1',
      'AvoidDiskWrites 1',
      'Log notice stderr',
    ].join('\n'));

    const torBin = findTorBinary();
    console.log(`[TorManager] Starting Tor for profile "${profileId}" on SOCKS:${socksPort}...`);

    return new Promise((resolve, reject) => {
      const proc = spawn(torBin, ['-f', torrc], { stdio: ['ignore', 'pipe', 'pipe'] });

      const instance: TorInstance = {
        process: proc,
        socksPort,
        controlPort,
        dataDir,
        profileId,
        ready: false,
      };
      instances.set(profileId, instance);

      let bootstrapped = false;
      const timeout = setTimeout(() => {
        if (!bootstrapped) {
          console.warn(`[TorManager] Tor for "${profileId}" timed out after 60s`);
          resolve({ socksPort }); // resolve anyway, might still work
        }
      }, 60000);

      const handleData = (data: Buffer) => {
        const line = data.toString();
        if (line.includes('Bootstrapped 100%')) {
          bootstrapped = true;
          instance.ready = true;
          clearTimeout(timeout);
          console.log(`[TorManager] Tor ready for profile "${profileId}" on SOCKS:${socksPort}`);

          // Try to get exit IP
          checkExitIp(socksPort).then(ip => {
            instance.exitIp = ip;
            if (ip) console.log(`[TorManager] Profile "${profileId}" exit IP: ${ip}`);
            resolve({ socksPort, exitIp: ip });
          }).catch(() => resolve({ socksPort }));
        }
        // Log bootstrap progress
        const match = line.match(/Bootstrapped (\d+)%/);
        if (match) {
          console.log(`[TorManager] Profile "${profileId}": Bootstrapped ${match[1]}%`);
        }
      };

      proc.stdout?.on('data', handleData);
      proc.stderr?.on('data', handleData);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        instances.delete(profileId);
        reject(new Error(`Failed to start Tor: ${err.message}`));
      });

      proc.on('exit', (code) => {
        if (!bootstrapped) {
          clearTimeout(timeout);
          instances.delete(profileId);
          reject(new Error(`Tor exited with code ${code}`));
        }
      });
    });
  },

  async stop(profileId: string): Promise<void> {
    const instance = instances.get(profileId);
    if (!instance) return;

    console.log(`[TorManager] Stopping Tor for profile "${profileId}"`);
    instance.process.kill('SIGINT');

    // Wait a bit then force kill
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (!instance.process.killed) {
      instance.process.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!instance.process.killed) instance.process.kill('SIGKILL');
    }

    // Cleanup data dir
    try { fs.rmSync(instance.dataDir, { recursive: true, force: true }); } catch {}
    instances.delete(profileId);
  },

  async newCircuit(profileId: string): Promise<void> {
    const instance = instances.get(profileId);
    if (!instance) return;

    // Send NEWNYM signal via control port
    return new Promise((resolve) => {
      const socket = net.createConnection(instance.controlPort, '127.0.0.1', () => {
        socket.write('AUTHENTICATE ""\r\n');
        socket.write('SIGNAL NEWNYM\r\n');
        setTimeout(() => { socket.end(); resolve(); }, 500);
      });
      socket.on('error', () => resolve());
    });
  },

  getInfo(profileId: string): { socksPort: number; exitIp?: string; ready: boolean } | null {
    const instance = instances.get(profileId);
    if (!instance) return null;
    return { socksPort: instance.socksPort, exitIp: instance.exitIp, ready: instance.ready };
  },

  isRunning(profileId: string): boolean {
    return instances.get(profileId)?.ready || false;
  },

  async stopAll(): Promise<void> {
    for (const id of instances.keys()) {
      await this.stop(id);
    }
  },
};

async function checkExitIp(socksPort: number): Promise<string | undefined> {
  try {
    // Use a simple HTTP request through the SOCKS proxy to check exit IP
    // We'll do this via a spawned curl command since it's simpler than implementing SOCKS in Node
    const { execSync } = require('child_process');
    const result = execSync(
      `curl -s --socks5-hostname 127.0.0.1:${socksPort} https://check.torproject.org/api/ip`,
      { timeout: 15000 }
    ).toString();
    const data = JSON.parse(result);
    if (data.IsTor) return data.IP;
  } catch {}
  return undefined;
}
