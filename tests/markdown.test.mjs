import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { markdownToNotionBlocks, summarizeNotionBlocks } from '../lib/notion-markdown.mjs';
import { buildReplaceBlocksTransaction } from '../lib/notion-internal-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const markdown = fs.readFileSync(path.join(here, 'fixtures/full-markdown.md'), 'utf8');
const PAGE_ID = '11111111-2222-4333-8444-555555555555';
const SPACE_ID = '99999999-8888-4777-8666-555555555555';

test('converts a representative Markdown document to Notion internal blocks', () => {
  const blocks = markdownToNotionBlocks(markdown);
  assert.deepEqual(summarizeNotionBlocks(blocks), {
    header: 1,
    sub_header: 1,
    sub_sub_header: 1,
    text: 1,
    bulleted_list: 2,
    numbered_list: 2,
    to_do: 2,
    quote: 1,
    callout: 1,
    code: 2,
    divider: 1,
  });
  assert.deepEqual(blocks[3].properties.title, [
    ['Paragraph with '],
    ['bold', [['b']]],
    [', '],
    ['italic', [['i']]],
    [', '],
    ['strikethrough', [['s']]],
    [', '],
    ['inline code', [['c']]],
    [', and an '],
    ['inline link', [['a', 'https://example.com/docs']]],
    ['.'],
  ]);
  assert.equal(blocks[4].properties.title[0][0], 'Bulleted item');
  assert.equal(blocks[4].children[0].properties.title[0][0], 'Nested bulleted item');
  assert.deepEqual(blocks[7].properties.checked, [['No']]);
  assert.deepEqual(blocks[8].properties.checked, [['Yes']]);
  assert.deepEqual(blocks[10].format, { page_icon: '💡', block_color: 'blue_background' });
  assert.deepEqual(blocks[11].properties.language, [['typescript']]);
  assert.deepEqual(blocks[12].properties.language, [['markdown']]);
});

test('builds one replacement transaction with recursive deletes and inserts', () => {
  const blocks = markdownToNotionBlocks('# Replacement\n\n- Parent\n  - Child');
  const ids = [
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    'cccccccc-dddd-4eee-8fff-000000000000',
  ];
  const transaction = buildReplaceBlocksTransaction({
    pageId: PAGE_ID,
    spaceId: SPACE_ID,
    existingBlocks: [
      { id: 'dddddddd-eeee-4fff-8000-111111111111', parentID: PAGE_ID },
      { id: 'eeeeeeee-ffff-4000-8111-222222222222', parentID: 'dddddddd-eeee-4fff-8000-111111111111' },
    ],
    blocks,
    now: 123,
    idFactory: () => ids.shift(),
  });
  const operations = transaction.payload.transactions[0].operations;
  assert.equal(operations[0].args.alive, false);
  assert.equal(operations[0].pointer.id, 'eeeeeeee-ffff-4000-8111-222222222222');
  assert.equal(operations[4].command, 'set');
  assert.equal(operations[4].args.type, 'header');
  assert.deepEqual(transaction.insertedIds, [
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    'cccccccc-dddd-4eee-8fff-000000000000',
  ]);
});
