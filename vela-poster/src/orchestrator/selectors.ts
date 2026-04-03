/**
 * Facebook DOM selectors and multi-language constants.
 * Ported from content.js defaultConfig and multi-language arrays.
 */

export const defaultConfig = {
  postSelectors: [
    'div[role="feed"] > div > div',
    '.x1lliihq .x1n2onr6.xh8yej3.x1ja2u2z.xod5an3',
  ],
  contentSelectors: [
    'div[data-ad-preview="message"]',
    'div[dir="auto"]',
    'div[data-visualcompletion="ignore-dynamic"]',
  ],
  composerSelectors: [
    '.x1yztbdb .xi81zsa.x1lkfr7t.xkjl1po.x1mzt3pk.xh8yej3.x13faqbe',
    '[data-composer-id="whats-on-your-mind"]',
    '.xi81zsa.x1lkfr7t.xkjl1po.x1mzt3pk.xh8yej3.x13faqbe',
  ],
  composerInputAreaSelectors: [
    '[role="dialog"] [role="presentation"] .notranslate[contenteditable="true"]',
    "div[contenteditable='true'][role='textbox']",
    ".xzsf02u.x1a2a7pz.x1n2onr6.x14wi4xw.notranslate[contenteditable='true']",
    "div[aria-label='Create a public post…'][contenteditable='true'][role='textbox']",
    ".notranslate._5rpu[contenteditable='true']",
    ".notranslate[contenteditable='true']",
    'div[role="textbox"][contenteditable="true"]',
  ],
  postButtonSelector: 'div[aria-label="Post"]',
};

/** Multi-language composer placeholder texts for detecting the composer trigger */
export const multiLangPlaceholders = [
  'write something',
  "what's on your mind",
  'what are you selling',
  'اكتب شيئًا',
  'بماذا تفكر',
  'ماذا تبيع',
  'escribe algo',
  '¿qué estás pensando?',
  '¿qué estás vendiendo?',
  'écrivez quelque chose',
  'à quoi pensez-vous',
  'que vendez-vous',
  'napisz coś',
  'o czym myślisz',
  'co sprzedajesz',
  'कुछ लिखें',
  'आप क्या सोच रहे हैं',
  'आप क्या बेच रहे हैं',
  '何か書く',
  '何を考えていますか',
  '何を売っていますか',
  '写点什么',
  '你在想什么',
  '你在卖什么',
  '寫點什麼',
  '你在想什麼',
  '你在賣什麼',
];

/** Multi-language post button translations */
export const POST_TRANSLATIONS = [
  'Post',           // English
  'Publier',        // French
  'पोस्ट करें',       // Hindi
  'Opublikuj',      // Polish
  'Publicar',       // Spanish
  'Postar',         // Portuguese
  'Veröffentlichen', // German
  'Надіслати',       // Ukrainian
  'نشر',            // Arabic
  '게시',            // Korean
  '投稿',            // Japanese
  '发布',            // Chinese
];
