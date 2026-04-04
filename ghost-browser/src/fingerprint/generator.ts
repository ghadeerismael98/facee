import { SeededPRNG } from './prng';

export interface FingerprintConfig {
  // Navigator
  hardwareConcurrency: number;
  deviceMemory: number;
  platform: string;
  vendor: string;
  maxTouchPoints: number;

  // Screen
  screenWidth: number;
  screenHeight: number;
  availWidth: number;
  availHeight: number;
  devicePixelRatio: number;
  colorDepth: number;

  // WebGL
  glVendor: string;
  glRenderer: string;

  // Canvas noise seeds (4 values 0-1)
  canvasNoise: [number, number, number, number];

  // Audio noise
  audioNoiseGain: number;  // tiny value like 0.00001-0.0001
  audioNoiseSeed: number;  // 0-1

  // Battery
  batteryCharging: boolean;
  batteryLevel: number;      // 0.2-1.0
  batteryChargingTime: number;
  batteryDischargingTime: number;

  // Network connection
  connectionEffectiveType: string;
  connectionDownlink: number;
  connectionRtt: number;

  // Client rect offset
  rectOffset: number;  // tiny offset like 0.00001-0.0001

  // Timezone (optional override)
  timezone?: string;
  timezoneOffset?: number;

  // Locale (optional override)
  locale?: string;

  // UserAgentData
  uaPlatform: string;
  uaBrands: Array<{ brand: string; version: string }>;
  uaMobile: boolean;
  uaPlatformVersion: string;
  uaArchitecture: string;
  uaBitness: string;
  uaModel: string;
  uaFullVersionList: Array<{ brand: string; version: string }>;

  // User Agent (matching platform)
  userAgent: string;

  // Storage estimate
  storageQuota: number;
  storageUsage: number;
}

const GPU_POOLS = {
  windows: [
    'ANGLE (NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
  ],
  mac: [
    'Apple M1',
    'Apple M1 Pro',
    'Apple M2',
    'Apple M2 Pro',
    'Apple M3',
    'Apple M3 Pro',
  ],
  linux: [
    'Mesa Intel(R) UHD Graphics 630 (CFL GT2)',
    'NVIDIA GeForce GTX 1660 Ti/PCIe/SSE2',
    'Mesa Intel(R) HD Graphics 530 (SKL GT2)',
    'AMD Radeon RX 580 Series (polaris10, LLVM 15.0.7, DRM 3.49)',
  ],
};

const CORE_POOLS = {
  windows: [4, 6, 8, 12, 16, 24, 32],
  mac: [4, 8, 10, 12, 16],
  linux: [4, 6, 8, 12, 16],
};

const MEMORY_POOL = [4, 8, 16, 32];

const DPR_POOLS = {
  windows: [1, 1.25, 1.5],
  mac: [2],
  linux: [1],
};

function detectPlatformFromUA(ua?: string): 'windows' | 'mac' | 'linux' {
  if (!ua) return 'windows';
  const lower = ua.toLowerCase();
  if (lower.includes('macintosh') || lower.includes('mac os')) return 'mac';
  if (lower.includes('linux') && !lower.includes('android')) return 'linux';
  return 'windows';
}

function getGLVendor(platform: 'windows' | 'mac' | 'linux', renderer: string): string {
  if (platform === 'mac') return 'Apple';
  if (platform === 'linux') {
    if (renderer.includes('NVIDIA')) return 'NVIDIA Corporation';
    if (renderer.includes('AMD') || renderer.includes('Radeon')) return 'X.Org';
    return 'Mesa';
  }
  // Windows
  if (renderer.includes('AMD') || renderer.includes('Radeon')) return 'Google Inc. (AMD)';
  if (renderer.includes('Intel')) return 'Google Inc. (Intel)';
  return 'Google Inc. (NVIDIA)';
}

function getPlatformString(platform: 'windows' | 'mac' | 'linux'): string {
  switch (platform) {
    case 'windows': return 'Win32';
    case 'mac': return 'MacIntel';
    case 'linux': return 'Linux x86_64';
  }
}

function getVendorString(platform: 'windows' | 'mac' | 'linux'): string {
  switch (platform) {
    case 'mac': return 'Apple Computer, Inc.';
    default: return 'Google Inc.';
  }
}

function getUAPlatform(platform: 'windows' | 'mac' | 'linux'): string {
  switch (platform) {
    case 'windows': return 'Windows';
    case 'mac': return 'macOS';
    case 'linux': return 'Linux';
  }
}

function getUAPlatformVersion(platform: 'windows' | 'mac' | 'linux', rng: SeededPRNG): string {
  switch (platform) {
    case 'windows': return `${rng.int(10, 15)}.0.0`;
    case 'mac': return `${rng.int(13, 15)}.${rng.int(0, 5)}.${rng.int(0, 3)}`;
    case 'linux': return `${rng.int(5, 6)}.${rng.int(0, 19)}.0`;
  }
}

function getUAArchitecture(platform: 'windows' | 'mac' | 'linux'): string {
  if (platform === 'mac') return 'arm';
  return 'x86';
}

function getUABitness(platform: 'windows' | 'mac' | 'linux'): string {
  return '64';
}

export function generateFingerprint(seed: number, platformHint?: string): FingerprintConfig {
  const rng = new SeededPRNG(seed);

  const platform = platformHint
    ? detectPlatformFromUA(platformHint)
    : (['windows', 'mac', 'linux'] as const)[rng.int(0, 2)];

  const gpuPool = GPU_POOLS[platform];
  const corePool = CORE_POOLS[platform];
  const dprPool = DPR_POOLS[platform];

  const glRenderer = rng.pick(gpuPool);
  const glVendor = getGLVendor(platform, glRenderer);

  const screenOffsetW = rng.int(0, 19);
  const screenOffsetH = rng.int(0, 19);
  const baseW = 1920;
  const baseH = 1080;

  const chromeMajor = rng.int(120, 128);
  const chromeFull = `${chromeMajor}.0.${rng.int(6000, 6800)}.${rng.int(50, 200)}`;

  const config: FingerprintConfig = {
    // Navigator
    hardwareConcurrency: rng.pick(corePool),
    deviceMemory: rng.pick(MEMORY_POOL),
    platform: getPlatformString(platform),
    vendor: getVendorString(platform),
    maxTouchPoints: platform === 'mac' ? 0 : rng.int(0, 1),

    // Screen
    screenWidth: baseW - screenOffsetW,
    screenHeight: baseH - screenOffsetH,
    availWidth: baseW - screenOffsetW,
    availHeight: baseH - screenOffsetH - rng.int(30, 50), // taskbar offset
    devicePixelRatio: rng.pick(dprPool),
    colorDepth: 24,

    // WebGL
    glVendor,
    glRenderer,

    // Canvas noise (4 seeds)
    canvasNoise: [rng.next(), rng.next(), rng.next(), rng.next()],

    // Audio
    audioNoiseGain: rng.float(0.00001, 0.0001),
    audioNoiseSeed: rng.next(),

    // Battery
    batteryCharging: rng.bool(0.6),
    batteryLevel: Math.round(rng.float(0.2, 1.0) * 100) / 100,
    batteryChargingTime: rng.bool(0.6) ? 0 : rng.int(300, 7200),
    batteryDischargingTime: rng.int(3600, 28800),

    // Network
    connectionEffectiveType: rng.pick(['4g', '4g', '4g', '3g']),
    connectionDownlink: rng.pick([1.5, 2.5, 5, 10, 10, 10]),
    connectionRtt: rng.pick([50, 50, 100, 100, 150]),

    // Client rect
    rectOffset: rng.float(0.00001, 0.0001),

    // UserAgentData
    uaPlatform: getUAPlatform(platform),
    uaBrands: [
      { brand: 'Chromium', version: String(chromeMajor) },
      { brand: 'Google Chrome', version: String(chromeMajor) },
      { brand: 'Not_A Brand', version: '24' },
    ],
    uaMobile: false,
    uaPlatformVersion: getUAPlatformVersion(platform, rng),
    uaArchitecture: getUAArchitecture(platform),
    uaBitness: getUABitness(platform),
    uaModel: '',
    uaFullVersionList: [
      { brand: 'Chromium', version: chromeFull },
      { brand: 'Google Chrome', version: chromeFull },
      { brand: 'Not_A Brand', version: '24.0.0.0' },
    ],

    // User Agent (matching platform)
    userAgent: generateMatchingUAFromPlatform(platform, rng),

    // Storage
    storageQuota: rng.int(200, 300) * 1024 * 1024 * 1024,  // 200-300 GB
    storageUsage: rng.int(50, 500) * 1024 * 1024,           // 50-500 MB
  };

  return config;
}

function generateMatchingUAFromPlatform(platform: 'windows' | 'mac' | 'linux', rng: SeededPRNG): string {
  const chromeVersion = 120 + rng.int(0, 10);
  const buildNum = 6000 + rng.int(0, 2000);
  switch (platform) {
    case 'windows':
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.${buildNum}.0 Safari/537.36`;
    case 'mac':
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.${buildNum}.0 Safari/537.36`;
    case 'linux':
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.${buildNum}.0 Safari/537.36`;
  }
}

/** Generate a User Agent string that matches the fingerprint platform */
export function generateMatchingUA(seed: number, platformHint?: string): string {
  const rng = new SeededPRNG(seed);
  const platform = platformHint
    ? detectPlatformFromUA(platformHint)
    : (['windows', 'mac', 'linux'] as const)[rng.int(0, 2)];

  const chromeVersion = 120 + rng.int(0, 10); // Chrome 120-130
  const buildNum = 6000 + rng.int(0, 2000);

  switch (platform) {
    case 'windows':
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.${buildNum}.0 Safari/537.36`;
    case 'mac':
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.${buildNum}.0 Safari/537.36`;
    case 'linux':
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.${buildNum}.0 Safari/537.36`;
  }
}
