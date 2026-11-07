import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { jsx: { runtime: 'automatic' }, tsconfigPaths: true });
const { ComposerActions } = await jiti.import('./ComposerActions.tsx');
const { I18nProvider } = await jiti.import('../hooks/useI18n.tsx');
function render(props) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ComposerActions, {
    mobile: false, streaming: false, sendEnabled: true, steerEnabled: true, followUpEnabled: true,
    attachmentBusy: false, steerHint: 'steer', followUpHint: 'follow-up', onSend() {}, onAbort() {}, ...props,
  })));
}
test('mobile send is a labeled 44px icon control, not a wide text button', () => {
  const html = render({ mobile: true });
  assert.match(html, /aria-label="Send"/);
  assert.match(html, /width:44px;height:44px/);
  assert.doesNotMatch(html, /Send<\/button>/);
});
test('mobile streaming actions share geometry and keep Stop outside the overflow menu', () => {
  const html = render({ mobile: true, streaming: true, onSteer() {}, onFollowUp() {} });
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.equal((html.match(/width:44px;height:44px/g) ?? []).length, 3);
  assert.equal((html.match(/aria-label=/g) ?? []).length, 3);
});
test('mobile always exposes Stop during a run, even without steer or follow-up support', () => {
  const html = render({ mobile: true, streaming: true });
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.match(html, /data-composer-stop/);
  assert.doesNotMatch(html, /display:none|visibility:hidden|disabled=""/);
});
test('desktop keeps text actions and does not duplicate its existing Stop button', () => {
  assert.match(render({}), /Send<\/button>/);
  const html = render({ streaming: true, onSteer() {}, onFollowUp() {} });
  assert.equal((html.match(/<button/g) ?? []).length, 2);
  assert.doesNotMatch(html, /width:44px/);
});
