// Bilingual copy helper for `src/client/ctrl/` modules so we do not alter
// upstream `src/client/i18n.js` 7-locale dictionary assertions in `test/i18n.test.js`.
import { language } from '../i18n.js'

export function isZh() {
  return String(language() ?? '').toLowerCase().startsWith('zh')
}

export function ct(zh, en, params) {
  const template = isZh() ? zh : en
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}
