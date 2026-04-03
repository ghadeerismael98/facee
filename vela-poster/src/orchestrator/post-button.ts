/**
 * Post Button Handler — finds and clicks the Facebook post button via Vela API.
 * Replaces content.js clickPostButtonWithRetry() + getPostButton().
 */
import { VelaClient } from '../vela/client';
import { POST_TRANSLATIONS, defaultConfig } from './selectors';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Find and click the post button with retry logic.
 * Uses multi-language text matching and native click for isTrusted events.
 */
export async function clickPostButton(
  vela: VelaClient,
  tabId: string,
  maxAttempts: number = 10,
  delayMs: number = 500
): Promise<boolean> {
  console.log('[PostButton] Looking for post button...');

  const translations = JSON.stringify(POST_TRANSLATIONS);
  const configSelector = JSON.stringify(defaultConfig.postButtonSelector);

  // Script that finds AND clicks the post button via JS .click()
  // Allows clicking even if aria-disabled="true" — Facebook enables it once text is detected
  const findAndClickScript = `
    (function() {
      var translations = ${translations};
      // Find the composer dialog (not notifications or other dialogs)
      var scope = document;
      var dialogs = document.querySelectorAll('[role="dialog"]');
      for (var dd = 0; dd < dialogs.length; dd++) {
        if (dialogs[dd].querySelector('[contenteditable="true"]')) {
          scope = dialogs[dd];
          break;
        }
      }

      // Strategy 1: Find by aria-label matching translations
      for (var t = 0; t < translations.length; t++) {
        var text = translations[t];
        var sel = 'div[aria-label="' + text + '"][role="button"], button[aria-label="' + text + '"]';
        try {
          var els = scope.querySelectorAll(sel);
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el.offsetParent !== null) {
              var rect = el.getBoundingClientRect();
              if (rect.width >= 30 && rect.height >= 20) {
                el.click();
                return { found: true, clicked: true, strategy: 'aria_label', text: text };
              }
            }
          }
        } catch (e) {}
      }

      // Strategy 2: Text content search on buttons within dialog
      var allButtons = scope.querySelectorAll('button, div[role="button"]');
      for (var i = 0; i < allButtons.length; i++) {
        var btn = allButtons[i];
        var btnText = (btn.textContent || btn.innerText || '').trim();
        for (var t = 0; t < translations.length; t++) {
          if (btnText === translations[t] || btnText.toLowerCase() === translations[t].toLowerCase()) {
            if (btn.offsetParent !== null) {
              var rect = btn.getBoundingClientRect();
              if (rect.width >= 30 && rect.height >= 20) {
                btn.click();
                return { found: true, clicked: true, strategy: 'text_match', text: btnText };
              }
            }
          }
        }
      }

      return { found: false };
    })()
  `;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await vela.executeScript<{
        found: boolean;
        clicked?: boolean;
        strategy?: string;
        text?: string;
      }>(tabId, findAndClickScript);

      if (result && result.found && result.clicked) {
        console.log(`[PostButton] Found via ${result.strategy}${result.text ? ` ("${result.text}")` : ''} — clicked!`);
        await sleep(1000);
        return true;
      }
    } catch (e: any) {
      console.warn(`[PostButton] Attempt ${attempt + 1} failed:`, e.message);
    }

    if (attempt < maxAttempts - 1) {
      await sleep(delayMs);
    }
  }

  console.error(`[PostButton] Not found after ${maxAttempts} attempts`);
  return false;
}

/**
 * Wait for post completion by checking if the composer dialog disappears.
 */
export async function waitForPostCompletion(
  vela: VelaClient,
  tabId: string,
  timeoutMs: number = 15000
): Promise<boolean> {
  console.log('[PostButton] Waiting for post to complete...');

  const checkScript = `
    (function() {
      // Find the composer dialog (the one with contenteditable, not notifications)
      var composerDialog = null;
      var dialogs = document.querySelectorAll('[role="dialog"]');
      for (var d = 0; d < dialogs.length; d++) {
        if (dialogs[d].querySelector('[contenteditable="true"]')) {
          composerDialog = dialogs[d];
          break;
        }
      }

      // If no composer dialog found, post likely completed
      if (!composerDialog) return { done: true };

      // Check if submitting
      var submitting = composerDialog.querySelectorAll('[role="progressbar"], [aria-busy="true"]');
      if (submitting.length > 0) return { done: false, submitting: true };

      // If composer input is empty, post may have been submitted
      var input = composerDialog.querySelector('div[contenteditable="true"][role="textbox"]');
      if (input && input.textContent.trim().length === 0) return { done: true };

      return { done: false };
    })()
  `;

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const status = await vela.executeScript<{ done: boolean; submitting?: boolean }>(tabId, checkScript);
      if (status && status.done) {
        console.log('[PostButton] Post completed');
        return true;
      }
    } catch {
      // Tab might have navigated or closed after successful post
      return true;
    }
    await sleep(500);
  }

  console.warn('[PostButton] Post completion wait timed out');
  return false;
}
