/**
 * Spintax expansion — ported directly from background.js expandSpintax().
 * Expands {option1|option2|option3} syntax with HTML tag preservation.
 */
export function expandSpintax(text: string): string {
  if (!text) return text;

  let spintaxGroupCount = 0;

  // Preserve HTML tags during spintax expansion
  const htmlMap: Record<number, string> = {};
  let htmlCounter = 0;
  const placeholder = (id: number) => `__HTML_PLACEHOLDER_${id}__`;

  // Extract HTML tags and replace with placeholders
  let processedText = text.replace(/<[^>]+>/g, (match) => {
    htmlMap[htmlCounter] = match;
    const ph = placeholder(htmlCounter);
    htmlCounter++;
    return ph;
  });

  // Parse and expand spintax groups {option1|option2|option3}
  let result = processedText.replace(/\{([^{}]+)\}/g, (match, content) => {
    const options = content.split('|').map((opt: string) => opt.trim()).filter((opt: string) => opt.length > 0);

    if (options.length > 1) {
      spintaxGroupCount++;
      const randomIndex = Math.floor(Math.random() * options.length);
      return options[randomIndex];
    }
    return match;
  });

  // Restore HTML tags from placeholders
  Object.keys(htmlMap).forEach((id) => {
    result = result.replace(placeholder(parseInt(id)), htmlMap[parseInt(id)]);
  });

  if (spintaxGroupCount > 0) {
    console.log(`[Spintax] Expanded ${spintaxGroupCount} groups`);
  }

  return result;
}

/**
 * Convert HTML to plain text preserving line breaks.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}
