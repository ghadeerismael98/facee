/**
 * Typed HTTP client for the Vela Browser REST API.
 * Wraps only the endpoints needed for campaign orchestration.
 */

interface VelaTab {
  id: string;
  url: string;
  title: string;
  windowId: string;
  active: boolean;
}

interface VelaStatus {
  version: string;
  uptime: number;
  windows: number;
  tabs: number;
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class VelaClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private async request<T = any>(method: string, path: string, body?: any): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Vela API ${method} ${path} failed (${res.status}): ${text}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json() as Promise<T>;
    }
    return res.text() as unknown as T;
  }

  // ── Status ─────────────────────────────────────────────────────────
  async getStatus(): Promise<VelaStatus> {
    return this.request('GET', '/api/status');
  }

  // ── Tabs ───────────────────────────────────────────────────────────
  async listTabs(): Promise<VelaTab[]> {
    return this.request('GET', '/api/tabs');
  }

  async createTab(url?: string, profileId?: string): Promise<VelaTab> {
    const body: any = {};
    if (url) body.url = url;
    if (profileId) body.profileId = profileId;
    return this.request('POST', '/api/tabs', body);
  }

  async closeTab(tabId: string): Promise<void> {
    await this.request('DELETE', `/api/tabs/${tabId}`);
  }

  async navigateTab(tabId: string, url: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/navigate`, { url });
  }

  async reloadTab(tabId: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/reload`);
  }

  // ── Wait functions ─────────────────────────────────────────────────
  async waitForLoad(tabId: string, state: 'load' | 'domcontentloaded' | 'networkidle' = 'load'): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/wait-for-load-state`, { state });
  }

  async waitForSelector(tabId: string, selector: string, timeout: number = 10000): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/wait`, { selector, state: 'attached', timeout });
  }

  async waitForFunction(tabId: string, expression: string, timeout: number = 30000): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/wait-for-function`, { expression, timeout });
  }

  async waitForNavigation(tabId: string, timeout: number = 30000): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/wait-for-navigation`, { timeout });
  }

  async waitForTimeout(tabId: string, ms: number): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/wait-for-timeout`, { timeout: ms });
  }

  // ── JavaScript execution ───────────────────────────────────────────
  async executeScript<T = any>(tabId: string, expression: string): Promise<T> {
    const res = await this.request<{ result: T }>('POST', `/api/tabs/${tabId}/execute`, { script: expression });
    return (res as any)?.result !== undefined ? (res as any).result : res as T;
  }

  // ── Element interaction ────────────────────────────────────────────
  async clickElement(tabId: string, selector: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/click`, { selector });
  }

  async fillElement(tabId: string, selector: string, value: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/fill`, { selector, value });
  }

  async typeText(tabId: string, selector: string, text: string, delay?: number): Promise<void> {
    const body: any = { selector, text };
    if (delay !== undefined) body.delay = delay;
    await this.request('POST', `/api/tabs/${tabId}/type`, body);
  }

  async extractText(tabId: string, selector: string): Promise<string> {
    const result = await this.request('POST', `/api/tabs/${tabId}/extract`, { selector });
    return result;
  }

  async scrollTo(tabId: string, selector: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/scroll`, { selector });
  }

  async hoverElement(tabId: string, selector: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/hover`, { selector });
  }

  async focusElement(tabId: string, selector: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/focus`, { selector });
  }

  // ── Element queries ────────────────────────────────────────────────
  async isElementVisible(tabId: string, selector: string): Promise<boolean> {
    const result = await this.request('POST', `/api/tabs/${tabId}/element/visible`, { selector });
    return result;
  }

  async getElementCount(tabId: string, selector: string): Promise<number> {
    const result = await this.request('POST', `/api/tabs/${tabId}/element/count`, { selector });
    return result;
  }

  async getBoundingBox(tabId: string, selector: string): Promise<BoundingBox> {
    return this.request('POST', `/api/tabs/${tabId}/element/bounding-box`, { selector });
  }

  async getInnerText(tabId: string, selector: string): Promise<string> {
    return this.request('POST', `/api/tabs/${tabId}/element/inner-text`, { selector });
  }

  // ── Native OS input (isTrusted: true) ──────────────────────────────
  async nativeClick(tabId: string, x: number, y: number): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/native/click`, { x, y });
  }

  async nativeType(tabId: string, text: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/native/type`, { text });
  }

  async nativePress(tabId: string, key: string, modifiers?: string[]): Promise<void> {
    const body: any = { key };
    if (modifiers) body.modifiers = modifiers;
    await this.request('POST', `/api/tabs/${tabId}/native/press`, body);
  }

  async nativePaste(tabId: string, text: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/native/paste`, { text });
  }

  async nativeMove(tabId: string, x: number, y: number): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/native/move`, { x, y });
  }

  // ── Mouse simulation ──────────────────────────────────────────────
  async mouseClick(tabId: string, x: number, y: number, button?: string): Promise<void> {
    const body: any = { x, y };
    if (button) body.button = button;
    await this.request('POST', `/api/tabs/${tabId}/mouse/click`, body);
  }

  async mouseMove(tabId: string, x: number, y: number, easing?: string): Promise<void> {
    const body: any = { x, y };
    if (easing) body.easing = easing;
    await this.request('POST', `/api/tabs/${tabId}/mouse/move`, body);
  }

  // ── Keyboard ──────────────────────────────────────────────────────
  async keyboardPress(tabId: string, key: string, modifiers?: string[]): Promise<void> {
    const body: any = { key };
    if (modifiers) body.modifiers = modifiers;
    await this.request('POST', `/api/tabs/${tabId}/keyboard/press`, body);
  }

  async keyboardInsertText(tabId: string, text: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/keyboard/insert-text`, { text });
  }

  // ── File upload ───────────────────────────────────────────────────
  async uploadFile(tabId: string, selector: string, file: string, filename?: string): Promise<void> {
    const body: any = { selector, file };
    if (filename) body.filename = filename;
    await this.request('POST', `/api/tabs/${tabId}/upload`, body);
  }

  // ── Cookies ───────────────────────────────────────────────────────
  async getCookies(tabId: string): Promise<any[]> {
    return this.request('GET', `/api/tabs/${tabId}/cookies`);
  }

  async setCookie(tabId: string, cookie: any): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/cookies`, cookie);
  }

  async clearCookies(tabId: string): Promise<void> {
    await this.request('DELETE', `/api/tabs/${tabId}/cookies`);
  }

  // ── Content capture ───────────────────────────────────────────────
  async getScreenshot(tabId: string): Promise<string> {
    return this.request('GET', `/api/tabs/${tabId}/screenshot`);
  }

  async getPageSource(tabId: string): Promise<string> {
    return this.request('GET', `/api/tabs/${tabId}/source`);
  }

  async getPageText(tabId: string): Promise<string> {
    return this.request('GET', `/api/tabs/${tabId}/text`);
  }

  async getPageTitle(tabId: string): Promise<string> {
    return this.request('GET', `/api/tabs/${tabId}/page-title`);
  }

  // ── Storage (per-tab localStorage/sessionStorage) ──────────────────
  async getLocalStorage(tabId: string, key: string): Promise<string | null> {
    const result = await this.request('POST', `/api/tabs/${tabId}/storage/local/get`, { key });
    return result;
  }

  async setLocalStorage(tabId: string, key: string, value: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/storage/local/set`, { key, value });
  }

  // ── Windows ───────────────────────────────────────────────────────
  async listWindows(): Promise<any[]> {
    const res = await this.request<any>('GET', '/api/windows');
    return res.windows || res || [];
  }

  async createWindow(profileId?: string): Promise<any> {
    const body: any = {};
    if (profileId) body.profileId = profileId;
    return this.request('POST', '/api/windows', body);
  }

  async closeWindow(windowId: string): Promise<void> {
    await this.request('DELETE', `/api/windows/${windowId}`);
  }

  // ── Profiles ──────────────────────────────────────────────────────
  async listProfiles(): Promise<any[]> {
    return this.request('GET', '/api/profiles');
  }

  async getProfile(profileId: string): Promise<any> {
    return this.request('GET', `/api/profiles/${profileId}`);
  }

  async updateProfile(profileId: string, data: Record<string, any>): Promise<any> {
    return this.request('PUT', `/api/profiles/${profileId}`, data);
  }

  // ── Dialog handling ───────────────────────────────────────────────
  async configureDialog(tabId: string, action: 'accept' | 'dismiss', promptText?: string): Promise<void> {
    const body: any = { action };
    if (promptText) body.promptText = promptText;
    await this.request('PUT', `/api/tabs/${tabId}/dialog/config`, body);
  }

  async acceptDialog(tabId: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/dialog/accept`);
  }

  async dismissDialog(tabId: string): Promise<void> {
    await this.request('POST', `/api/tabs/${tabId}/dialog/dismiss`);
  }
}
