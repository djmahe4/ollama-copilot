/**
 * Chat Webview Helpers
 *
 * CSP-ready HTML generation utilities used by ChatViewProvider.
 * Extracted here to keep the upstream chatView.ts unchanged.
 *
 * 23. CSP-ready code patterns (Content Security Policy nonce helpers)
 * 24. Accessibility hooks (ARIA attributes, semantic HTML helpers)
 * 22. Security validation (HTML escaping to prevent XSS)
 * 25. Internationalization readiness (RTL/LTR direction helpers)
 *
 * Cross-platform: pure TypeScript, no OS-specific APIs.
 *
 * DELTA TYPE: EXTEND (new helper module, upstream chatView.ts untouched)
 */

import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CspPolicy {
  readonly nonce: string;
  readonly headerValue: string;
}

export interface HtmlSanitiseOptions {
  /** Allow basic markdown-derived tags (b, i, code, pre, ul, ol, li, p). */
  allowMarkdown?: boolean;
}

// ---------------------------------------------------------------------------
// 23 – CSP nonce generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random nonce and build a Content Security
 * Policy header value safe for use in VS Code webviews.
 * (technique 23 – CSP-ready code patterns)
 *
 * Uses `crypto.randomBytes` which is available on Windows, macOS, Linux.
 */
export function generateCsp(webviewUri: string): CspPolicy {
  // 16 random bytes → 32 hex characters – sufficient nonce entropy
  const nonce = crypto.randomBytes(16).toString('hex');

  const headerValue = [
    `default-src 'none'`,
    `style-src 'nonce-${nonce}' 'unsafe-inline'`,  // VS Code themes use inline styles
    `script-src 'nonce-${nonce}'`,
    `img-src ${webviewUri} data: https:`,
    `connect-src 'none'`,
    `font-src 'none'`
  ].join('; ');

  return { nonce, headerValue };
}

// ---------------------------------------------------------------------------
// 22 – HTML escaping  (prevents XSS from user/model content)
// ---------------------------------------------------------------------------

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/**
 * Escape a string for safe insertion into HTML text content or attributes.
 * (technique 22 – security / input sanitisation)
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch] ?? ch);
}

// ---------------------------------------------------------------------------
// 24 – Accessibility helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a chat message in a semantically correct, accessible HTML element.
 * Adds `role`, `aria-label`, and `aria-live` attributes.
 * (technique 24 – accessibility hooks)
 */
export function accessibleMessageHtml(
  type: 'user' | 'assistant' | 'system' | 'error',
  content: string
): string {
  const ariaRole = type === 'user' ? 'article' : 'status';
  const ariaLabel = labelFor(type);
  const ariaLive = type === 'assistant' || type === 'system' ? ' aria-live="polite"' : '';
  const escaped = escapeHtml(content);
  return `<div role="${ariaRole}" aria-label="${ariaLabel}"${ariaLive} class="msg msg-${type}">${escaped}</div>`;
}

// ---------------------------------------------------------------------------
// 25 – i18n / direction helpers
// ---------------------------------------------------------------------------

/**
 * Return the appropriate text direction for a given locale string.
 * RTL locales: Arabic (ar), Hebrew (he), Persian (fa), Urdu (ur).
 * (technique 25 – internationalization readiness)
 */
export function textDirection(locale: string): 'ltr' | 'rtl' {
  const rtlLocales = new Set(['ar', 'he', 'fa', 'ur', 'yi', 'dv']);
  const base = locale.split('-')[0].toLowerCase();
  return rtlLocales.has(base) ? 'rtl' : 'ltr';
}

/**
 * Build the `<html>` opening tag with the correct `lang` and `dir`
 * attributes based on the VS Code locale.
 */
export function htmlOpenTag(locale: string = 'en'): string {
  const dir = textDirection(locale);
  return `<html lang="${escapeHtml(locale)}" dir="${dir}">`;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function labelFor(type: 'user' | 'assistant' | 'system' | 'error'): string {
  switch (type) {
    case 'user':      return 'Your message';
    case 'assistant': return 'AI response';
    case 'system':    return 'System message';
    case 'error':     return 'Error message';
    // Exhaustive – TypeScript will error if a new type is added without updating here
  }
}
