/**
 * File Upload Handler — uploads images/videos to Facebook via Vela API.
 * Replaces content.js insertImage().
 */
import { VelaClient } from '../vela/client';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Click the "Photo/video" button to open the file picker, then upload a file.
 */
export async function uploadMedia(
  vela: VelaClient,
  tabId: string,
  base64Data: string,
  isVideo: boolean = false
): Promise<boolean> {
  console.log(`[Upload] Uploading ${isVideo ? 'video' : 'image'}...`);

  try {
    // Step 1: Click the "Photo/video" button (multi-language)
    const clickPhotoButtonScript = `
      (function() {
        const selectors = [
          'div[aria-label="Photo/video"][role="button"]',
          'div[aria-label*="Photo"][role="button"]',
          'div[aria-label*="photo"][role="button"]',
          'div[aria-label*="Foto"][role="button"]',
          'div[aria-label*="Photo/vidéo"][role="button"]',
          'div[aria-label*="Fénykép"][role="button"]',
          '[data-testid="media-attachment"]',
          'div[aria-label*="video"][role="button"]',
        ];
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
              }
            }
          } catch (e) {}
        }
        return { found: false };
      })()
    `;

    const photoBtn = await vela.executeScript<{ found: boolean; x?: number; y?: number }>(tabId, clickPhotoButtonScript);

    if (photoBtn && photoBtn.found) {
      await vela.nativeClick(tabId, Math.round(photoBtn.x!), Math.round(photoBtn.y!));
      await sleep(1500);
    }

    // Step 2: Find the file input and upload via Vela's upload API
    const fileInputSelector = 'input[type="file"][accept*="image"], input[type="file"][accept*="video"], input[type="file"]';

    try {
      await vela.waitForSelector(tabId, fileInputSelector, 5000);
    } catch {
      console.warn('[Upload] File input not found, trying without waiting...');
    }

    // Detect mime type from base64
    let mimeType = 'image/jpeg';
    if (base64Data.startsWith('data:')) {
      const match = base64Data.match(/^data:([^;]+);/);
      if (match) mimeType = match[1];
    }

    const ext = mimeType.includes('video') ? '.mp4' :
                mimeType.includes('png') ? '.png' :
                mimeType.includes('gif') ? '.gif' :
                mimeType.includes('webp') ? '.webp' : '.jpg';

    const filename = `upload_${Date.now()}${ext}`;

    // Strip data URI prefix if present for Vela's upload
    const cleanBase64 = base64Data.includes(',') ? base64Data : `data:${mimeType};base64,${base64Data}`;

    await vela.uploadFile(tabId, fileInputSelector, cleanBase64, filename);
    console.log(`[Upload] File uploaded: ${filename}`);

    // Wait for upload to process
    if (isVideo) {
      await sleep(3000);
    } else {
      await sleep(1500);
    }

    return true;
  } catch (e: any) {
    console.error('[Upload] Failed:', e.message);
    return false;
  }
}

/**
 * Wait for video upload processing to complete by checking the DOM for progress indicators.
 */
export async function waitForVideoUploadComplete(
  vela: VelaClient,
  tabId: string,
  maxWaitSeconds: number = 300
): Promise<boolean> {
  console.log('[Upload] Waiting for video upload to complete...');

  const checkScript = `
    (function() {
      // Check if upload progress indicator is still visible
      const progressBar = document.querySelector('[role="progressbar"]');
      const uploadingText = Array.from(document.querySelectorAll('span, div')).find(
        el => (el.textContent || '').toLowerCase().includes('uploading')
      );
      return { uploading: !!(progressBar || uploadingText) };
    })()
  `;

  const startTime = Date.now();
  const timeoutMs = maxWaitSeconds * 1000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const status = await vela.executeScript<{ uploading: boolean }>(tabId, checkScript);
      if (status && !status.uploading) {
        console.log('[Upload] Video upload complete');
        return true;
      }
    } catch {
      // Tab might be loading, retry
    }
    await sleep(2000);
  }

  console.warn('[Upload] Video upload wait timed out');
  return false;
}
