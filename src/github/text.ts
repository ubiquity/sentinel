/**
 * PR body text handling: preserve the source body exactly except for GitHub
 * issue auto-close keywords, which are removed before publication (the plan:
 * avoid auto-closing issue keywords before production acceptance). The body
 * itself is never rewritten otherwise; only the keyword immediately followed
 * by an issue reference is dropped, so `Fixes #123` and
 * `Fixes ubiquity/sentinel#123` publish as their references while the rest of
 * the text stays byte-identical.
 */

const AUTO_CLOSE_KEYWORD_RE =
  /\b(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s*:?\s*(?=(?:[\w-]+\/[\w.-]+)?#\d+\b)/giu;

export function sanitizeAutoCloseKeywords(body: string): string {
  return body.replace(AUTO_CLOSE_KEYWORD_RE, "");
}
