import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentFileId,
  buildAppendBlockTransaction,
  buildAppendFilePlaceholderTransaction,
  buildAppendImagePlaceholderTransaction,
  buildAppendStructuredBlocksTransaction,
  buildCreatePageTransaction,
  buildDeleteBlockTransaction,
  buildDuplicateBlockTransaction,
  buildDuplicatePageTransaction,
  buildFinalizeFileTransaction,
  buildFinalizeImageTransaction,
  buildMoveBlockTransaction,
  buildPageArchiveTransaction,
  buildPageRestoreTransaction,
  buildReparentBlockTransaction,
  buildRemoveBlockTransaction,
  buildUpdateBlockTransaction,
  getUploadSpaceFileUrl,
  getSignedFileUrl,
  loadPageChunk,
  normalizeBlockType,
  notionId,
  parsePageChunk,
  saveTransaction,
  uploadSignedFile,
  downloadSignedFile,
  downloadSignedFileViaPage,
  deleteContentRecords,
} from '../lib/notion-internal-api.mjs';

const PAGE_ID = '11111111-2222-4333-8444-555555555555';
const BLOCK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SPACE_ID = '99999999-8888-4777-8666-555555555555';

function pageChunk() {
  return {
    cursor: { stack: [] },
    recordMap: {
      block: {
        [PAGE_ID]: {
          spaceId: SPACE_ID,
          value: {
            value: {
              id: PAGE_ID,
              type: 'page',
              properties: { title: [['Project Alpha']] },
              content: [BLOCK_ID],
              space_id: SPACE_ID,
              alive: true,
            },
            role: 'editor',
          },
        },
        [BLOCK_ID]: {
          spaceId: SPACE_ID,
          value: {
            value: {
              id: BLOCK_ID,
              type: 'text',
              properties: { title: [['First '], ['paragraph', [['b']]]] },
              parent_id: PAGE_ID,
              space_id: SPACE_ID,
              alive: true,
            },
          },
        },
      },
    },
  };
}

test('extracts a dashed page ID from current Notion URL shapes', () => {
  assert.equal(notionId(`https://app.notion.com/p/example/${PAGE_ID.replaceAll('-', '')}?pvs=3`), PAGE_ID);
  assert.equal(notionId(`https://www.notion.so/Page-${PAGE_ID.replaceAll('-', '')}`), PAGE_ID);
  assert.equal(notionId(PAGE_ID), PAGE_ID);
  assert.equal(notionId('https://example.com/no-id'), '');
});

test('normalizes the supported block type aliases', () => {
  assert.equal(normalizeBlockType('paragraph'), 'text');
  assert.equal(normalizeBlockType('heading-2'), 'sub_header');
  assert.equal(normalizeBlockType('bulleted'), 'bulleted_list');
  assert.throws(() => normalizeBlockType('unsupported'), /Unsupported block type/);
});

test('parses nested recordMap values into ordered normalized blocks', () => {
  const result = parsePageChunk(pageChunk(), PAGE_ID);
  assert.equal(result.title, 'Project Alpha');
  assert.equal(result.spaceId, SPACE_ID);
  assert.deepEqual(result.blocks, [{
    index: 0,
    id: BLOCK_ID,
    type: 'text',
    text: 'First paragraph',
    depth: 0,
    parentID: PAGE_ID,
  }]);
  assert.equal(result.text, 'First paragraph');
});

test('builds an append transaction without exposing browser cookies', () => {
  const result = buildAppendBlockTransaction({
    pageId: PAGE_ID,
    spaceId: SPACE_ID,
    afterId: BLOCK_ID,
    text: 'Second paragraph',
    now: 123,
    blockId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  });
  const operations = result.payload.transactions[0].operations;
  assert.equal(result.payload.transactions[0].spaceId, SPACE_ID);
  assert.equal(operations[0].command, 'set');
  assert.equal(operations[0].args.properties.title[0][0], 'Second paragraph');
  assert.deepEqual(operations[1].args, {
    id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    after: BLOCK_ID,
  });
  assert.equal(operations[2].args.last_edited_time, 123);
  assert.equal(JSON.stringify(result.payload).includes('cookie'), false);
});

test('builds page creation and title update transactions', () => {
  const created = buildCreatePageTransaction({
    parentId: PAGE_ID,
    spaceId: SPACE_ID,
    afterId: BLOCK_ID,
    title: 'CLI test page',
    content: 'Initial paragraph',
    now: 456,
    pageId: 'cccccccc-dddd-4eee-8fff-000000000000',
    blockId: 'dddddddd-eeee-4fff-8000-111111111111',
  });
  const createOps = created.payload.transactions[0].operations;
  assert.equal(createOps[0].args.type, 'page');
  assert.equal(createOps[0].args.properties.title[0][0], 'CLI test page');
  assert.equal(createOps[2].args.parent_id, created.pageId);
  assert.equal(createOps[2].args.properties.title[0][0], 'Initial paragraph');

  const updated = buildUpdateBlockTransaction({
    blockId: BLOCK_ID,
    spaceId: SPACE_ID,
    text: 'Updated',
    now: 789,
  });
  assert.deepEqual(updated.transactions[0].operations[0], {
    pointer: { table: 'block', id: BLOCK_ID, spaceId: SPACE_ID },
    path: ['properties'],
    command: 'update',
    args: { title: [['Updated']] },
  });
});

test('builds a same-parent block move transaction', () => {
  const payload = buildMoveBlockTransaction({
    parentId: PAGE_ID,
    blockId: BLOCK_ID,
    afterId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    spaceId: SPACE_ID,
    now: 321,
  });
  const operations = payload.transactions[0].operations;
  assert.deepEqual(operations[0].args, { id: BLOCK_ID });
  assert.deepEqual(operations[1].args, {
    id: BLOCK_ID,
    after: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  });
  assert.equal(operations[2].args.last_edited_time, 321);
  assert.throws(() => buildMoveBlockTransaction({
    parentId: PAGE_ID,
    blockId: BLOCK_ID,
    afterId: BLOCK_ID,
    spaceId: SPACE_ID,
  }), /cannot be moved after itself/);
});

test('builds append, delete, duplicate, and reparent block transactions', () => {
  const parsed = parsePageChunk(pageChunk(), PAGE_ID);
  const ids = [
    '10101010-1111-4222-8333-444444444444',
    '20202020-1111-4222-8333-444444444444',
  ];
  const appended = buildAppendStructuredBlocksTransaction({
    pageId: PAGE_ID,
    spaceId: SPACE_ID,
    afterId: BLOCK_ID,
    blocks: [{
      type: 'bulleted_list',
      properties: { title: [['Parent']] },
      children: [{ type: 'bulleted_list', properties: { title: [['Child']] } }],
    }],
    now: 10,
    idFactory: () => ids.shift(),
  });
  assert.equal(appended.rootIds.length, 1);
  assert.equal(appended.insertedIds.length, 2);
  assert.equal(appended.payload.transactions[0].operations.some((operation) => operation.command === 'listRemove'), false);

  const deleted = buildDeleteBlockTransaction({ pageData: parsed, blockId: BLOCK_ID, now: 20 });
  assert.equal(deleted.transactions[0].operations[0].args.alive, false);

  const duplicated = buildDuplicateBlockTransaction({
    pageData: parsed,
    blockId: BLOCK_ID,
    now: 30,
    idFactory: () => '30303030-1111-4222-8333-444444444444',
  });
  assert.equal(duplicated.payload.transactions[0].operations[0].args.properties.title[0][0], 'First ');
  assert.equal(duplicated.payload.transactions[0].operations[1].args.after, BLOCK_ID);

  const reparented = buildReparentBlockTransaction({
    blockId: BLOCK_ID,
    fromParentId: PAGE_ID,
    toParentId: '40404040-1111-4222-8333-444444444444',
    afterId: '50505050-1111-4222-8333-444444444444',
    spaceId: SPACE_ID,
    now: 40,
  });
  const reparentOps = reparented.transactions[0].operations;
  assert.equal(reparentOps[0].command, 'listRemove');
  assert.equal(reparentOps[1].args.parent_id, '40404040-1111-4222-8333-444444444444');
  assert.equal(reparentOps[2].command, 'listAfter');
});

test('builds page duplicate, archive, and restore transactions', () => {
  const parsed = parsePageChunk(pageChunk(), PAGE_ID);
  const duplicateIds = [
    '60606060-1111-4222-8333-444444444444',
    '70707070-1111-4222-8333-444444444444',
  ];
  const duplicated = buildDuplicatePageTransaction({
    pageData: parsed,
    parentId: '80808080-1111-4222-8333-444444444444',
    title: 'Copy',
    now: 50,
    idFactory: () => duplicateIds.shift(),
  });
  assert.equal(duplicated.payload.transactions[0].operations[0].args.type, 'page');
  assert.equal(duplicated.payload.transactions[0].operations[0].args.properties.title[0][0], 'Copy');
  assert.equal(duplicated.insertedIds.length, 2);

  const archived = buildPageArchiveTransaction({
    pageId: PAGE_ID,
    parentId: '80808080-1111-4222-8333-444444444444',
    spaceId: SPACE_ID,
    now: 60,
  });
  assert.equal(archived.transactions[0].operations[0].command, 'removeChild');
  assert.equal(archived.transactions[0].operations[0].additionalUpdatedPointers.length, 2);

  const restored = buildPageRestoreTransaction({
    pageId: PAGE_ID,
    parentId: '80808080-1111-4222-8333-444444444444',
    afterId: BLOCK_ID,
    spaceId: SPACE_ID,
    now: 70,
  });
  assert.equal(restored.transactions[0].operations[0].args.alive, true);
  assert.equal(restored.transactions[0].operations[1].args.after, BLOCK_ID);
});

test('builds the image placeholder, finalization, and rollback transactions', () => {
  const placeholder = buildAppendImagePlaceholderTransaction({
    pageId: PAGE_ID,
    spaceId: SPACE_ID,
    afterId: BLOCK_ID,
    fileName: 'sample.png',
    sizeText: '1.5 KB',
    width: 512,
    height: 256,
    now: 100,
    blockId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  });
  const placeholderOps = placeholder.payload.transactions[0].operations;
  assert.equal(placeholderOps[0].args.type, 'image');
  assert.equal(placeholderOps[0].args.format.block_aspect_ratio, 0.5);
  assert.equal(placeholderOps[1].args.after, BLOCK_ID);

  const source = 'attachment:12121212-3434-4567-8989-121212121212:sample.png';
  assert.equal(attachmentFileId(source), '12121212-3434-4567-8989-121212121212');
  const finalized = buildFinalizeImageTransaction({
    pageId: PAGE_ID,
    blockId: placeholder.blockId,
    spaceId: SPACE_ID,
    source,
    fileName: 'sample.png',
    sizeText: '1.5 KB',
    caption: 'Sample caption',
    width: 512,
    height: 256,
    now: 200,
  });
  const finalOps = finalized.transactions[0].operations;
  assert.equal(finalOps[0].args.source[0][0], source);
  assert.equal(finalOps[0].args.caption[0][0], 'Sample caption');
  assert.deepEqual(finalOps[2].args.file_ids, ['12121212-3434-4567-8989-121212121212']);

  const rollback = buildRemoveBlockTransaction({
    pageId: PAGE_ID,
    blockId: placeholder.blockId,
    spaceId: SPACE_ID,
    now: 300,
  });
  assert.equal(rollback.transactions[0].operations[0].args.alive, false);
  assert.deepEqual(rollback.transactions[0].operations[1].args, { id: placeholder.blockId });
});

test('builds file placeholder and finalization transactions', () => {
  const placeholder = buildAppendFilePlaceholderTransaction({
    pageId: PAGE_ID,
    spaceId: SPACE_ID,
    fileName: 'notes.pdf',
    sizeText: '2.0 KB',
    now: 80,
    blockId: BLOCK_ID,
  });
  assert.equal(placeholder.payload.transactions[0].operations[0].args.type, 'file');
  const source = 'attachment:90909090-1111-4222-8333-444444444444:notes.pdf';
  const finalized = buildFinalizeFileTransaction({
    pageId: PAGE_ID,
    blockId: BLOCK_ID,
    spaceId: SPACE_ID,
    source,
    fileName: 'notes.pdf',
    sizeText: '2.0 KB',
    caption: 'Notes',
    now: 90,
  });
  assert.equal(finalized.transactions[0].operations[0].args.source[0][0], source);
  assert.deepEqual(finalized.transactions[0].operations[1].args.file_ids, ['90909090-1111-4222-8333-444444444444']);
});

test('uses browser-context JSON requests for reads and writes', async () => {
  const calls = [];
  const page = {
    async fetchJson(url, options) {
      calls.push({ url, options });
      return url.endsWith('/loadPageChunk') ? pageChunk() : {};
    },
  };
  const loaded = await loadPageChunk(page, PAGE_ID);
  assert.equal(loaded.title, 'Project Alpha');
  await saveTransaction(page, SPACE_ID, { transactions: [] });
  assert.equal(calls[0].url, 'https://app.notion.com/api/v3/loadPageChunk');
  assert.equal(calls[0].options.body.pageId, PAGE_ID);
  assert.equal(calls[1].url, 'https://app.notion.com/api/v3/saveTransactionsFanout');
  assert.equal(calls[1].options.headers['x-notion-space-id'], SPACE_ID);
});

test('hydrates referenced blocks omitted by loadPageChunk', async () => {
  const rootId = '11111111-1111-4111-8111-111111111111';
  const childId = '22222222-2222-4222-8222-222222222222';
  const spaceId = '33333333-3333-4333-8333-333333333333';
  const calls = [];
  const page = {
    async fetchJson(url) {
      calls.push(url);
      if (url.endsWith('/loadPageChunk')) {
        return {
          recordMap: {
            block: {
              [rootId]: { value: { value: { id: rootId, type: 'page', space_id: spaceId, content: [childId] } } },
            },
          },
        };
      }
      return {
        recordMap: {
          block: {
            [childId]: { value: { value: { id: childId, type: 'text', parent_id: rootId, alive: true, properties: { title: [['Hydrated']] } } } },
          },
        },
      };
    },
  };
  const result = await loadPageChunk(page, rootId);
  assert.equal(result.blocks[0].text, 'Hydrated');
  assert.match(calls[1], /syncRecordValues$/);
});

test('hydrates comments referenced by discussions', async () => {
  const rootId = '11111111-1111-4111-8111-111111111111';
  const spaceId = '22222222-2222-4222-8222-222222222222';
  const discussionId = '33333333-3333-4333-8333-333333333333';
  const commentId = '44444444-4444-4444-8444-444444444444';
  const userId = '55555555-5555-4555-8555-555555555555';
  const page = {
    async fetchJson(url, options) {
      if (url.endsWith('/loadPageChunk')) {
        return {
          recordMap: {
            block: { [rootId]: { value: { value: { id: rootId, type: 'page', space_id: spaceId, discussions: [discussionId] } } } },
            discussion: { [discussionId]: { value: { value: { id: discussionId, comments: [commentId] } } } },
          },
        };
      }
      const table = options.body.requests[0].pointer.table;
      if (table === 'comment') {
        return { recordMap: { comment: { [commentId]: { value: { value: { id: commentId, created_by_id: userId, text: [['Hello']] } } } } } };
      }
      return { recordMap: { notion_user: { [userId]: { value: { value: { id: userId, name: 'Tester' } } } } } };
    },
  };
  const result = await loadPageChunk(page, rootId);
  assert.equal(result.comments[commentId].text[0][0], 'Hello');
  assert.equal(result.users[userId].name, 'Tester');
});

test('requests a workspace upload URL and sends bytes without browser cookies', async () => {
  const calls = [];
  const page = {
    async fetchJson(url, options) {
      calls.push({ url, options });
      return {
        type: 'PUT',
        url: 'attachment:12121212-3434-4567-8989-121212121212:sample.png',
        signedPutUrl: 'https://uploads.example.test/signed',
        putHeaders: [{ name: 'x-amz-tagging', value: 'source=UserUpload' }],
      };
    },
  };
  const upload = await getUploadSpaceFileUrl(page, {
    spaceId: SPACE_ID,
    blockId: BLOCK_ID,
    fileName: 'sample.png',
    contentType: 'image/png',
    contentLength: 3,
  });
  assert.equal(calls[0].url, 'https://app.notion.com/api/v3/getUploadSpaceFileUrl');
  assert.deepEqual(calls[0].options.body.record, { table: 'block', id: BLOCK_ID, spaceId: SPACE_ID });
  assert.equal(JSON.stringify(calls[0]).includes('cookie'), false);

  let sent;
  await uploadSignedFile(upload, Buffer.from([1, 2, 3]), 'image/png', async (url, options) => {
    sent = { url, options };
    return { ok: true, status: 200 };
  });
  assert.equal(sent.url, 'https://uploads.example.test/signed');
  assert.equal(sent.options.method, 'PUT');
  assert.equal(sent.options.headers.get('Content-Type'), 'image/png');
  assert.equal(sent.options.headers.get('x-amz-tagging'), 'source=UserUpload');
});

test('requests a signed download URL and downloads bytes', async () => {
  const calls = [];
  const page = {
    async fetchJson(url, options) {
      calls.push({ url, options });
      return { signedUrls: ['https://files.example.test/signed'] };
    },
  };
  const signedUrl = await getSignedFileUrl(page, {
    source: 'attachment:90909090-1111-4222-8333-444444444444:notes.pdf',
    blockId: BLOCK_ID,
    spaceId: SPACE_ID,
  });
  assert.equal(signedUrl, 'https://files.example.test/signed');
  assert.equal(calls[0].url, 'https://app.notion.com/api/v3/getSignedFileUrls');
  assert.equal(JSON.stringify(calls[0]).includes('cookie'), false);
  const bytes = await downloadSignedFile(signedUrl, async () => ({
    ok: true,
    status: 200,
    async arrayBuffer() { return Uint8Array.from([4, 5, 6]).buffer; },
  }));
  assert.deepEqual([...bytes], [4, 5, 6]);
});

test('downloads signed bytes inside the browser session', async () => {
  const page = {
    async evaluateWithArgs(_script, args) {
      assert.equal(args.downloadUrl, 'https://file.example/test');
      return { ok: true, base64: Buffer.from('browser bytes').toString('base64'), size: 13 };
    },
  };
  const bytes = await downloadSignedFileViaPage(page, 'https://file.example/test');
  assert.equal(bytes.toString(), 'browser bytes');
});

test('moves a page to Notion trash without permanent deletion', async () => {
  const page = {
    async fetchJson(url, options) {
      assert.match(url, /deleteContentRecords$/);
      assert.equal(options.body.permanentlyDelete, false);
      assert.deepEqual(options.body.records, [{ id: PAGE_ID, table: 'block', spaceId: SPACE_ID }]);
      return { recordMap: {} };
    },
  };
  await deleteContentRecords(page, { pageId: PAGE_ID, spaceId: SPACE_ID });
});
