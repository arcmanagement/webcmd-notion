import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { buildExtractScript, createNotionParser } from '../lib/notion-dom-parser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageHTML = fs.readFileSync(path.join(here, 'fixtures/page.html'), 'utf8');
const loginHTML = fs.readFileSync(path.join(here, 'fixtures/login.html'), 'utf8');

function domFor(html, url) {
  return new JSDOM(html, { url, runScripts: 'outside-only' });
}

test('detects an authenticated Notion workspace', () => {
  const dom = domFor(pageHTML, 'https://www.notion.so/Project-Alpha-222');
  const result = createNotionParser(dom.window.document, dom.window.location).page();
  assert.equal(result.authRequired, false);
  assert.equal(result.appVisible, true);
  assert.equal(result.pageVisible, true);
  assert.equal(result.workspaceName, 'Customer Workspace');
});

test('detects the Notion login page', () => {
  const dom = domFor(loginHTML, 'https://www.notion.com/login');
  const result = createNotionParser(dom.window.document, dom.window.location).page();
  assert.equal(result.authRequired, true);
  assert.equal(result.appVisible, false);
});

test('extracts normalized page blocks and links', () => {
  const dom = domFor(pageHTML, 'https://www.notion.so/Project-Alpha-222');
  const parser = createNotionParser(dom.window.document, dom.window.location);
  const result = parser.read();
  assert.equal(result.title, 'Project Alpha');
  assert.deepEqual(result.blocks.map(({ type, text }) => ({ type, text })), [
    { type: 'text', text: 'First paragraph' },
    { type: 'bulleted_list', text: 'Second item' },
  ]);
  assert.deepEqual(parser.links(), [
    { index: 0, text: 'Specification', url: 'https://example.com/spec' },
  ]);
});

test('extracts sidebar, favorites, and search rows', () => {
  const dom = domFor(pageHTML, 'https://www.notion.so/Project-Alpha-222');
  const parser = createNotionParser(dom.window.document, dom.window.location);
  assert.equal(parser.sidebar().length, 3);
  assert.deepEqual(parser.favorites(), [
    { index: 0, title: '⭐ Favorite Page', url: 'https://www.notion.so/Favorite-111' },
  ]);
  assert.deepEqual(parser.search(), [
    { index: 0, title: 'Search Result', url: 'https://www.notion.so/Search-Result-444', kind: 'page' },
  ]);
});

test('extracts workspace names, access, and current selection', () => {
  const dom = domFor(pageHTML, 'https://app.notion.com/p/customer/Page-222');
  const parser = createNotionParser(dom.window.document, dom.window.location);
  assert.deepEqual(parser.workspaces(), [
    { index: 0, title: 'Personal Workspace', access: '', current: false },
    { index: 1, title: 'Customer Workspace', access: 'ゲスト', current: true },
    { index: 2, title: 'ArcManagement', access: 'ゲスト', current: false },
  ]);
});

test('browser extraction script uses the same parser contract', () => {
  const dom = domFor(pageHTML, 'https://www.notion.so/Project-Alpha-222');
  const result = dom.window.eval(buildExtractScript('read', { limit: 1 }));
  assert.equal(result.ok, true);
  assert.equal(result.value.blocks.length, 1);
  assert.equal(result.value.blocks[0].text, 'First paragraph');
});

test('browser extraction script reports unsupported operations', () => {
  const dom = domFor(pageHTML, 'https://www.notion.so/Project-Alpha-222');
  const result = dom.window.eval(buildExtractScript('missing'));
  assert.equal(result.ok, false);
  assert.match(result.error, /Unsupported Notion parser operation/);
});
