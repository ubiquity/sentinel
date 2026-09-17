/**
 * PR body text handling: preserve the source body exactly except for GitHub
 * issue auto-close keywords, which are removed before publication (the plan:
 * avoid auto-closing issue keywords before production acceptance). The body
 * itself is never rewritten otherwise; only a standalone keyword with a
 * colon/spacing separator before an issue reference is dropped; for example,
 * `Fixes #123` and `Fixes ubiquity/sentinel#123` publish as their references
 * while the rest of the text stays byte-identical.
 */

const AUTO_CLOSE_KEYWORD_RE =
  /(?<![\w/?&=/-])(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)(?![\w-])(?:\s+:\s*|\s+|:\s*)(?=(?:[\w-]+\/[\w.-]+)?#\d+\b)/giu;

export function sanitizeAutoCloseKeywords(body: string): string {
  return body.replace(AUTO_CLOSE_KEYWORD_RE, "");
}
