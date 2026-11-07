import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { jsx: { runtime: 'automatic' }, tsconfigPaths: true });
const { ThemePicker } = await jiti.import('./ThemePicker.tsx');
const { LanguagePicker } = await jiti.import('./LanguagePicker.tsx');
const { MobileToolbarMenu } = await jiti.import('./MobileToolbarMenu.tsx');
const { I18nProvider } = await jiti.import('../hooks/useI18n.tsx');
function render(component, props) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(component, props)));
}
test('compact theme and language triggers share 44px targets and accessible names', () => {
  for (const component of [ThemePicker, LanguagePicker]) {
    const html = render(component, { compact: true });
    assert.match(html, /height:44px/);
    assert.match(html, /width:44px/);
    assert.match(html, /aria-label=/);
    assert.match(html, /display:none/);
  }
});
test('wide toolbar pickers retain their original text-button height', () => {
  for (const component of [ThemePicker, LanguagePicker]) assert.match(render(component, {}), /height:36px/);
});
test('secondary mobile actions do not occupy a second row while closed', () => {
  const html = render(MobileToolbarMenu, { label: 'More actions', items: [{ key: 'system', label: 'System prompt', onSelect() {} }] });
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /role="menuitem"/);
});
