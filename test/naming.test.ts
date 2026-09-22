import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEMPLATE, renderName } from '../src/main/naming';

const date = new Date(2026, 8, 23, 14, 5, 9);

test('the default template matches the old file names', () => {
  assert.equal(renderName(DEFAULT_TEMPLATE, { date }), 'ShotKit 2026-09-23 at 14.05.09');
});

test('tokens and folders', () => {
  assert.equal(
    renderName('{year}/{month}/{app} {width}x{height} #{n}', { date, app: 'Chrome', width: 800, height: 600, n: 7 }),
    '2026/09/Chrome 800x600 #007',
  );
});

test('unknown tokens stay as typed', () => {
  assert.equal(renderName('{nope} {date}', { date }), '{nope} 2026-09-23');
});

test('values cannot escape the save folder or use invalid characters', () => {
  assert.equal(renderName('{title}', { date, title: '../../etc/passwd' }), '-..-etc-passwd'); // leading dots are dropped
  assert.equal(renderName('../{title}', { date, title: 'a:b*c?' }), 'abc');
  assert.equal(renderName('a/../b', { date }), 'a/b');
  assert.equal(renderName('CON', { date }), '_CON');
});

test('an empty result falls back to the default name', () => {
  assert.equal(renderName('{app}', { date }), 'ShotKit 2026-09-23 at 14.05.09');
  assert.equal(renderName('', { date }), 'ShotKit 2026-09-23 at 14.05.09');
});
