/**
 * PR body text handling: preserve the source body exactly except for GitHub
 * issue auto-close keywords, which are removed before publication (the plan:
 * avoid auto-closing issue keywords before production acceptance). The body
 * itself is never rewritten otherwise; only a standalone keyword with a
 * colon/spacing separator before an issue reference is dropped; for example,
 * `Fixes #123` and `Fixes ubiquity/sentinel#123` publish as their references
 * while the rest of the text stays byte-identical.
 */

const URL_START_RE = /(?:(?:https?|ftp):\/\/|www\.)/giu;
const URL_DELIMITER_RE = /[\s<>"'`]/u;

const AUTO_CLOSE_KEYWORD_RE =
  /(?<![\w./?&=/-])(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)(?![\w-])(?:\s+:\s*|\s+|:\s*)(?=(?:[\w-]+\/[\w.-]+)?#\d+\b)/giu;

function sanitizeNonUrlText(text: string): string {
  return text.replace(AUTO_CLOSE_KEYWORD_RE, "");
}

/** Find a URL's end without consuming a Markdown closing parenthesis. */
function findUrlEnd(text: string, start: number): number {
  let parentheses = 0;
  for (let cursor = start; cursor < text.length; cursor++) {
    const character = text[cursor];
    if (URL_DELIMITER_RE.test(character)) return cursor;
    if (character === "(") {
      parentheses++;
    } else if (character === ")") {
      if (parentheses === 0) return cursor;
      parentheses--;
    }
  }
  return text.length;
}

export function sanitizeAutoCloseKeywords(body: string): string {
  let sanitized = "";
  let cursor = 0;
  for (const match of body.matchAll(URL_START_RE)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    const end = findUrlEnd(body, start);
    sanitized += sanitizeNonUrlText(body.slice(cursor, start));
    sanitized += body.slice(start, end);
    cursor = end;
  }
  return sanitized + sanitizeNonUrlText(body.slice(cursor));
}
