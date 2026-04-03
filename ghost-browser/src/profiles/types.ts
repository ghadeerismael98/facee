export interface ProxyConfig {
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface GhostProfile {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  fingerprintSeed: number;
  fingerprintEnabled: boolean;
  userAgent?: string;
  timezone?: string;
  locale?: string;
  proxy?: ProxyConfig;
  torEnabled?: boolean;
  viewport?: { width: number; height: number };
  // Vela-compat fields
  spoofLanguage?: string | null;
  spoofTimezone?: string | null;
  userAgentId?: string | null;
  dnsProvider?: string | null;
  contentBlockerEnabled?: boolean | null;
  blockTrackers?: boolean | null;
  blockAds?: boolean | null;
  blockPopups?: boolean | null;
  httpsFirstEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}
