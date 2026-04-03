/**
 * Composer Handler — opens Facebook group composer and injects content via Vela API.
 * Replaces content.js openComposer() + injectIntoComposer().
 */
import { VelaClient } from '../vela/client';
import { multiLangPlaceholders, defaultConfig } from './selectors';
import { htmlToPlainText } from './spintax';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Find and click the composer trigger element on a Facebook group page.
 * Uses Vela's executeScript to run DOM queries, then clicks via native input.
 */
export async function openComposer(vela: VelaClient, tabId: string): Promise<boolean> {
  console.log('[Composer] Looking for composer trigger...');

  // Strategy 1: Multi-language placeholder text search
  const placeholdersJSON = JSON.stringify(multiLangPlaceholders);
  const findComposerScript = `
    (function() {
      const placeholders = ${placeholdersJSON};
      const tags = ['span', 'div'];

      // Search by visible text content
      for (const tag of tags) {
        const els = document.querySelectorAll(tag);
        for (const el of els) {
          const text = (el.textContent || '').toLowerCase().trim();
          if (placeholders.some(kw => text.includes(kw.toLowerCase()))) {
            // Get bounding box for native click
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, strategy: 'text_match' };
            }
          }
        }
      }

      // Strategy 2: Input-like elements (placeholder, aria-label, title)
      const inputLike = document.querySelectorAll(
        'textarea, input[placeholder], input[aria-label], [contenteditable="true"], [role="textbox"]'
      );
      for (const el of inputLike) {
        const attrs = [
          el.getAttribute('placeholder'),
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.textContent,
        ].filter(Boolean).map(s => s.toLowerCase());
        if (attrs.some(a => placeholders.some(kw => a.includes(kw.toLowerCase())))) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, strategy: 'input_attr' };
          }
        }
      }

      // Strategy 3: Config-based CSS selectors
      const selectors = ${JSON.stringify(defaultConfig.composerSelectors)};
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, strategy: 'css_selector' };
            }
          }
        } catch (e) {}
      }

      return { found: false };
    })()
  `;

  // Retry up to 10 times — Facebook SPA may still be rendering
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const result = await vela.executeScript<{ found: boolean; x?: number; y?: number; strategy?: string }>(tabId, findComposerScript);

      if (result && result.found && result.x !== undefined && result.y !== undefined) {
        console.log(`[Composer] Found via ${result.strategy} at (${result.x}, ${result.y}) on attempt ${attempt + 1}`);
        // Use JS click via executeScript — more reliable than nativeClick when window isn't focused
        await vela.executeScript(tabId, `
          (function() {
            var placeholders = ${placeholdersJSON};
            var tags = ['span', 'div'];
            for (var t = 0; t < tags.length; t++) {
              var els = document.querySelectorAll(tags[t]);
              for (var i = 0; i < els.length; i++) {
                var text = (els[i].textContent || '').toLowerCase().trim();
                if (placeholders.some(function(kw) { return text.includes(kw.toLowerCase()); })) {
                  var rect = els[i].getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0 && rect.width < 800) {
                    els[i].click();
                    return true;
                  }
                }
              }
            }
            return false;
          })()
        `);
        await sleep(2000);
        return true;
      }
    } catch (e: any) {
      console.error(`[Composer] Script execution failed (attempt ${attempt + 1}):`, e.message);
    }

    if (attempt < 9) {
      console.log(`[Composer] Not found yet, retrying in 2s... (attempt ${attempt + 1}/10)`);
      await sleep(2000);
    }
  }

  console.error('[Composer] Could not find composer trigger after 10 attempts');
  return false;
}

/**
 * Wait for the composer input (contenteditable textbox) to appear after clicking the trigger.
 */
export async function waitForComposerInput(vela: VelaClient, tabId: string, timeout: number = 15000): Promise<boolean> {
  console.log('[Composer] Waiting for input element...');

  const inputSelectors = defaultConfig.composerInputAreaSelectors;

  // Try each selector with Vela's wait function
  for (const selector of inputSelectors) {
    try {
      await vela.waitForSelector(tabId, selector, timeout);
      console.log(`[Composer] Input found with selector: ${selector}`);
      return true;
    } catch {
      // Selector not found, try next
    }
  }

  // Generic fallback
  try {
    await vela.waitForSelector(tabId, "div[contenteditable='true'][role='textbox']", timeout);
    return true;
  } catch {
    console.error('[Composer] Input element not found after timeout');
    return false;
  }
}

/**
 * Inject text into the composer using Vela's keyboard/insert-text API.
 * This is the only method that reliably works with Facebook's Lexical editor.
 * Requires nativeClick on the input first to set focus.
 */
export async function injectText(vela: VelaClient, tabId: string, html: string): Promise<boolean> {
  console.log('[Composer] Injecting text into composer...');

  const plainText = htmlToPlainText(html);
  const escapedText = JSON.stringify(plainText);

  // Single script: find the composer input (skipping comment boxes and non-composer dialogs),
  // focus it, and inject text via execCommand. No window focus needed.
  const injectScript = `
    (function() {
      var selectors = [
        'div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]',
        '.notranslate[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]'
      ];

      function isComposerInput(el) {
        if (!el || el.offsetParent === null) return false;
        if (el.closest && el.closest('[aria-label*="comment"], [aria-label*="Comment"], [aria-label*="Reply"], [aria-label*="reply"]')) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 100 && rect.height > 20;
      }

      // Search all dialogs for the composer input
      var el = null;
      var dialogs = document.querySelectorAll('[role="dialog"]');
      for (var d = 0; d < dialogs.length; d++) {
        for (var s = 0; s < selectors.length; s++) {
          var candidates = dialogs[d].querySelectorAll(selectors[s]);
          for (var c = 0; c < candidates.length; c++) {
            if (isComposerInput(candidates[c])) { el = candidates[c]; break; }
          }
          if (el) break;
        }
        if (el) break;
      }

      // Fallback: search entire document
      if (!el) {
        for (var s = 0; s < selectors.length; s++) {
          var candidates = document.querySelectorAll(selectors[s]);
          for (var c = 0; c < candidates.length; c++) {
            if (isComposerInput(candidates[c])) { el = candidates[c]; break; }
          }
          if (el) break;
        }
      }

      if (!el) return { success: false, reason: 'no_element' };

      // Focus and set cursor
      el.focus();
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);

      // Inject via execCommand
      var text = ${escapedText};
      var result = document.execCommand('insertText', false, text);

      // execCommand returns true if it ran — trust it, don't check textContent
      // because Lexical's React re-render is async
      return { success: result, length: text.length };
    })()
  `;

  try {
    const result = await vela.executeScript<{ success: boolean; length?: number; reason?: string }>(tabId, injectScript);

    if (result && result.success) {
      console.log(`[Composer] Text injected via execCommand (${result.length} chars)`);
      await sleep(1000); // Wait for Lexical to process
      return true;
    }

    console.error(`[Composer] Text injection failed: ${result?.reason || 'execCommand returned false'}`);
    return false;
  } catch (e: any) {
    console.error('[Composer] Text injection error:', e.message);
    return false;
  }
}
