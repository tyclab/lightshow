import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { test, expect } from '@playwright/test';

const { outputFiles } = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
    contents: `
      import { h, render, options } from 'preact';
      import { useRef } from 'preact/hooks';
      import { useFocusTrap } from './public-src/focus-trap.js';
      const pending = [];
      options.requestAnimationFrame = callback => pending.push(callback);
      function Dialog() {
        const box = useRef(null);
        useFocusTrap(box, true, () => window.closedDialogs++);
        return h('div', {ref: box, role: 'dialog', 'aria-label': 'Deferred focus'},
          h('button', {id: 'first'}, 'First control'),
          h('input', {id: 'cadence', type: 'number', value: '2',
            onBlur: event => { event.currentTarget.value = '2'; }}));
      }
      window.closedDialogs = 0;
      window.flushFocusTrap = () => { const work = pending.splice(0); work.forEach(callback => callback()); return work.length; };
      document.querySelector('#outside').focus();
      render(h(Dialog), document.querySelector('#mount'));
    `,
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
});

async function fixture(page) {
  await page.setContent('<button id="outside">Outside</button><div id="mount"></div>');
  await page.addScriptTag({ content: outputFiles[0].text });
}

test('a deferred focus trap preserves a field already being edited inside the dialog', async ({ page }) => {
  await fixture(page);
  const cadence = page.locator('#cadence');
  await cadence.fill('');
  expect(await page.evaluate(() => window.flushFocusTrap())).toBe(1);
  await expect(cadence).toBeFocused();
  await cadence.pressSequentially('0.5');
  await expect(cadence).toHaveValue('0.5');
});

test('a deferred trap still moves outside focus inside and handles Escape', async ({ page }) => {
  await fixture(page);
  expect(await page.evaluate(() => window.flushFocusTrap())).toBe(1);
  await expect(page.locator('#first')).toBeFocused();
  await page.locator('#outside').focus();
  await expect(page.locator('#first')).toBeFocused();
  await page.locator('#cadence').press('Escape');
  expect(await page.evaluate(() => window.closedDialogs)).toBe(1);
});
