/**
 * PR body text handling: preserve the source body exactly except for GitHub
 * issue auto-close keywords, which are removed before publication (the plan:
 * avoid auto-closing issue keywords before production acceptance). The body
 * itself is never rewritten otherwise; only a standalone keyword with a
 * colon/spacing separator before an issue reference is dropped; for example,
 * `Fixes #123` and `Fixes ubiquity/sentinel#123` publish as their references
 * while the rest of the text stays byte-identical.
 */

const URL_START_RE = /(?:(?<![\w./])(?:https?|ftp):\/\/|(?<![\w./-])www\.)/giu;
const MARKDOWN_LINK_START_RE = /\]\(/gu;
const MARKDOWN_REFERENCE_START_RE =
  /(?:^|\r?\n)[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*/gmu;
const URL_DELIMITER_RE = /[\s<>"'`]/u;

const AUTO_CLOSE_KEYWORD_RE =
  /(?<![\w./?&=/-])(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)(?![\w-])(?:\s+:\s*|\s+|:\s*)(?=(?:[\w-]+\/[\w.-]+)?#\d+\b)/giu;

function sanitizeNonUrlText(text: string): string {
  return text.replace(AUTO_CLOSE_KEYWORD_RE, "");
}

interface ProtectedRange {
  start: number;
  end: number;
}

function findMarkdownDestination(
  text: string,
  openParenthesis: number,
): ProtectedRange | undefined {
  let start = openParenthesis + 1;
  while (start < text.length && /\s/u.test(text[start])) start++;
  if (start >= text.length || text[start] === ")") return undefined;

  if (text[start] === "<") {
    const end = text.indexOf(">", start + 1);
    if (end < 0) return undefined;
    return { start, end: end + 1 };
  }

  let parentheses = 0;
  for (let cursor = start; cursor < text.length; cursor++) {
    const character = text[cursor];
    if (/\s/u.test(character) || character === "<" || character === ">") {
      return { start, end: cursor };
    }
    if (character === "\\") {
      cursor++;
    } else if (character === "(") {
      parentheses++;
    } else if (character === ")") {
      if (parentheses === 0) return { start, end: cursor };
      parentheses--;
    }
  }
  return undefined;
}

/** Find a URL's end without consuming a Markdown closing parenthesis. */
function findUrlEnd(text: string, start: number): number {
  if (text[start - 1] === "<") {
    const end = text.indexOf(">", start + 1);
    if (end >= 0) return end;
  }

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

function protectedRanges(body: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];

  for (const match of body.matchAll(MARKDOWN_LINK_START_RE)) {
    const start = match.index ?? 0;
    const destination = findMarkdownDestination(body, start + 1);
    if (destination !== undefined && destination.end > destination.start) {
      ranges.push(destination);
    }
  }

  for (const match of body.matchAll(MARKDOWN_REFERENCE_START_RE)) {
    const start = (match.index ?? 0) + match[0].length;
    const lineEnd = body.indexOf("\n", start);
    const end = lineEnd < 0 ? body.length : lineEnd;
    if (end > start) ranges.push({ start, end });
  }

  for (const match of body.matchAll(URL_START_RE)) {
    const start = match.index ?? 0;
    const end = findUrlEnd(body, start);
    if (end > start) ranges.push({ start, end });
  }

  ranges.sort((left, right) =>
    left.start - right.start || right.end - left.end
  );
  const merged: ProtectedRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function sanitizeAutoCloseKeywords(body: string): string {
  let sanitized = "";
  let cursor = 0;
  for (const range of protectedRanges(body)) {
    if (range.start < cursor) continue;
    sanitized += sanitizeNonUrlText(body.slice(cursor, range.start));
    sanitized += body.slice(range.start, range.end);
    cursor = range.end;
  }
  return sanitized + sanitizeNonUrlText(body.slice(cursor));
}
