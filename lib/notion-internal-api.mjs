import { randomUUID } from 'node:crypto';

const API_ROOT = 'https://app.notion.com/api/v3';

export const INTERNAL_API_CHANGE_HINT = [
  'Notion internal API may have changed.',
  'Update the request builders and their fixtures before retrying.',
].join(' ');

const BLOCK_TYPE_ALIASES = new Map([
  ['paragraph', 'text'],
  ['text', 'text'],
  ['heading1', 'header'],
  ['heading2', 'sub_header'],
  ['heading3', 'sub_sub_header'],
  ['bulleted', 'bulleted_list'],
  ['numbered', 'numbered_list'],
  ['todo', 'to_do'],
  ['quote', 'quote'],
  ['callout', 'callout'],
  ['code', 'code'],
  ['divider', 'divider'],
]);

export function notionId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const withoutQuery = raw.split(/[?#]/, 1)[0];
  const match = withoutQuery.match(/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!match) return '';
  const compact = match[1].replaceAll('-', '').toLowerCase();
  return [compact.slice(0, 8), compact.slice(8, 12), compact.slice(12, 16), compact.slice(16, 20), compact.slice(20)].join('-');
}

export function unwrapRecord(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const first = entry.value;
  if (!first || typeof first !== 'object') return null;
  if (first.value && typeof first.value === 'object' && first.value.id) return first.value;
  return first;
}

export function richTextToPlain(value) {
  if (!Array.isArray(value)) return '';
  return value.map((segment) => Array.isArray(segment) ? String(segment[0] ?? '') : '').join('');
}

export function normalizeBlockType(value) {
  const key = String(value ?? 'paragraph').trim().toLowerCase().replaceAll('-', '').replaceAll('_', '');
  for (const [alias, type] of BLOCK_TYPE_ALIASES) {
    if (alias.replaceAll('_', '') === key) return type;
  }
  throw new Error(`Unsupported block type: ${value}`);
}

export function parsePageChunk(payload, pageId, limit = 200) {
  const normalizedPageId = notionId(pageId);
  const rawBlocks = payload?.recordMap?.block;
  if (!rawBlocks || typeof rawBlocks !== 'object') {
    throw new Error('loadPageChunk returned no block record map');
  }

  const blocksById = new Map();
  for (const [id, entry] of Object.entries(rawBlocks)) {
    const block = unwrapRecord(entry);
    if (block?.id) blocksById.set(notionId(id) || id, block);
  }

  const parseRecordTable = (table) => Object.fromEntries(
    Object.entries(payload?.recordMap?.[table] || {})
      .map(([id, entry]) => [notionId(id) || id, unwrapRecord(entry)])
      .filter(([, value]) => value),
  );

  const root = blocksById.get(normalizedPageId);
  if (!root) throw new Error(`Root page block was not returned: ${normalizedPageId}`);
  const spaceId = root.space_id
    || rawBlocks[normalizedPageId]?.spaceId
    || rawBlocks[normalizedPageId]?.value?.spaceId
    || '';

  const rows = [];
  const visited = new Set();
  const visit = (id, depth) => {
    const normalized = notionId(id) || id;
    if (visited.has(normalized) || rows.length >= limit) return;
    visited.add(normalized);
    const block = blocksById.get(normalized);
    if (!block || block.alive === false) return;
    const text = richTextToPlain(block.properties?.title);
    const row = {
      index: rows.length,
      id: normalized,
      type: block.type || 'block',
      text,
      depth,
      parentID: notionId(block.parent_id) || block.parent_id || '',
    };
    const source = richTextToPlain(block.properties?.source);
    const caption = richTextToPlain(block.properties?.caption);
    const fileName = richTextToPlain(block.properties?.title);
    const size = richTextToPlain(block.properties?.size);
    const checked = richTextToPlain(block.properties?.checked);
    const language = richTextToPlain(block.properties?.language);
    if (source) row.source = source;
    if (caption) row.caption = caption;
    if (source && fileName) row.fileName = fileName;
    if (source && size) row.size = size;
    if (checked) row.checked = checked;
    if (language) row.language = language;
    if (block.format?.page_icon) row.icon = block.format.page_icon;
    if (block.format?.block_color) row.color = block.format.block_color;
    if (Number.isFinite(block.format?.block_width)) row.width = block.format.block_width;
    if (Number.isFinite(block.format?.block_height)) row.height = block.format.block_height;
    rows.push(row);
    for (const childId of block.content || []) visit(childId, depth + 1);
  };

  for (const childId of root.content || []) visit(childId, 0);
  return {
    id: normalizedPageId,
    title: richTextToPlain(root.properties?.title) || 'Untitled',
    spaceId,
    root,
    content: Array.isArray(root.content) ? [...root.content] : [],
    blocks: rows,
    records: Object.fromEntries(blocksById),
    collections: parseRecordTable('collection'),
    collectionViews: parseRecordTable('collection_view'),
    discussions: parseRecordTable('discussion'),
    comments: parseRecordTable('comment'),
    users: parseRecordTable('notion_user'),
    text: rows.map((row) => row.text).filter(Boolean).join('\n'),
  };
}

export function blockPointer(id, spaceId) {
  return { table: 'block', id, spaceId };
}

export function buildTransaction(spaceId, operations, userAction = 'webcmd.notion') {
  return {
    requestId: randomUUID(),
    transactions: [{
      id: randomUUID(),
      spaceId,
      debug: { userAction },
      operations,
    }],
  };
}

function touchOperation(id, spaceId, now) {
  return {
    pointer: blockPointer(id, spaceId),
    path: [],
    command: 'update',
    args: { last_edited_time: now },
  };
}

function insertOperations({ id, parentId, afterId, spaceId, type, text, now }) {
  const properties = type === 'divider' ? {} : { title: [[text]] };
  const value = {
    id,
    parent_id: parentId,
    parent_table: 'block',
    alive: true,
    created_time: now,
    last_edited_time: now,
    space_id: spaceId,
    type,
    properties,
  };
  const listArgs = { id };
  if (afterId) listArgs.after = afterId;
  return [
    {
      pointer: blockPointer(id, spaceId),
      path: [],
      command: 'set',
      args: value,
    },
    {
      pointer: blockPointer(parentId, spaceId),
      path: ['content'],
      command: 'listAfter',
      args: listArgs,
    },
  ];
}

function structuredInsertOperations({ block, parentId, afterId, spaceId, now, idFactory }) {
  const id = idFactory();
  const children = Array.isArray(block.children) ? block.children : [];
  const value = {
    id,
    parent_id: parentId,
    parent_table: 'block',
    alive: true,
    created_time: now,
    last_edited_time: now,
    space_id: spaceId,
    type: block.type,
    properties: block.properties || {},
  };
  if (block.format && Object.keys(block.format).length) value.format = block.format;
  if (Array.isArray(block.file_ids) && block.file_ids.length) value.file_ids = [...block.file_ids];
  const listArgs = { id };
  if (afterId) listArgs.after = afterId;
  const operations = [
    {
      pointer: blockPointer(id, spaceId),
      path: [],
      command: 'set',
      args: value,
    },
    {
      pointer: blockPointer(parentId, spaceId),
      path: ['content'],
      command: 'listAfter',
      args: listArgs,
    },
  ];
  const ids = [id];
  let childAfter = '';
  for (const child of children) {
    const inserted = structuredInsertOperations({
      block: child,
      parentId: id,
      afterId: childAfter,
      spaceId,
      now,
      idFactory,
    });
    operations.push(...inserted.operations);
    ids.push(...inserted.ids);
    childAfter = inserted.id;
  }
  return { id, ids, operations };
}

function deleteTreeOperations(id, parentId, spaceId, childrenByParent) {
  const operations = [];
  for (const childId of childrenByParent.get(id) || []) {
    operations.push(...deleteTreeOperations(childId, id, spaceId, childrenByParent));
  }
  operations.push(
    {
      pointer: blockPointer(id, spaceId),
      path: [],
      command: 'update',
      args: { alive: false },
    },
    {
      pointer: blockPointer(parentId, spaceId),
      path: ['content'],
      command: 'listRemove',
      args: { id },
    },
  );
  return operations;
}

export function buildAppendBlockTransaction({ pageId, spaceId, afterId = '', text, type = 'paragraph', now = Date.now(), blockId = randomUUID() }) {
  const normalizedType = normalizeBlockType(type);
  const operations = [
    ...insertOperations({ id: blockId, parentId: pageId, afterId, spaceId, type: normalizedType, text, now }),
    touchOperation(pageId, spaceId, now),
  ];
  return { blockId, payload: buildTransaction(spaceId, operations, 'webcmd.notion.block-add') };
}

export function blockTreeFromPage(pageData, blockId) {
  const records = pageData?.records || {};
  const source = records[blockId];
  if (!source) throw new Error(`Block record not found: ${blockId}`);
  const clone = {
    type: source.type,
    properties: structuredClone(source.properties || {}),
  };
  if (source.format && Object.keys(source.format).length) clone.format = structuredClone(source.format);
  if (Array.isArray(source.file_ids) && source.file_ids.length) clone.file_ids = [...source.file_ids];
  const children = (source.content || []).map((id) => blockTreeFromPage(pageData, notionId(id) || id));
  if (children.length) clone.children = children;
  return clone;
}

export function buildAppendStructuredBlocksTransaction({
  pageId,
  spaceId,
  afterId = '',
  blocks,
  now = Date.now(),
  idFactory = randomUUID,
  userAction = 'webcmd.notion.blocks-append',
}) {
  const operations = [];
  const insertedIds = [];
  const rootIds = [];
  let anchor = afterId;
  for (const block of blocks) {
    const inserted = structuredInsertOperations({
      block,
      parentId: pageId,
      afterId: anchor,
      spaceId,
      now,
      idFactory,
    });
    operations.push(...inserted.operations);
    insertedIds.push(...inserted.ids);
    rootIds.push(inserted.id);
    anchor = inserted.id;
  }
  operations.push(touchOperation(pageId, spaceId, now));
  return {
    insertedIds,
    rootIds,
    payload: buildTransaction(spaceId, operations, userAction),
  };
}

export function buildAppendImagePlaceholderTransaction({
  pageId,
  spaceId,
  afterId = '',
  fileName,
  sizeText,
  width,
  height,
  now = Date.now(),
  blockId = randomUUID(),
}) {
  const properties = {
    title: [[fileName]],
    size: [[sizeText]],
  };
  const format = {
    block_width: Math.min(width, 700),
    block_height: Math.min(height, 400),
    block_aspect_ratio: height / width,
    block_preserve_scale: false,
    block_full_width: false,
    block_page_width: false,
  };
  const operations = [
    {
      pointer: blockPointer(blockId, spaceId),
      path: [],
      command: 'set',
      args: {
        id: blockId,
        parent_id: pageId,
        parent_table: 'block',
        alive: true,
        created_time: now,
        last_edited_time: now,
        space_id: spaceId,
        type: 'image',
        properties,
        format,
      },
    },
    {
      pointer: blockPointer(pageId, spaceId),
      path: ['content'],
      command: 'listAfter',
      args: afterId ? { id: blockId, after: afterId } : { id: blockId },
    },
    touchOperation(pageId, spaceId, now),
  ];
  return {
    blockId,
    payload: buildTransaction(spaceId, operations, 'webcmd.notion.image-add.placeholder'),
  };
}

export function attachmentFileId(source) {
  const match = String(source ?? '').match(/^attachment:([^:]+):/);
  return match?.[1] || '';
}

export function buildFinalizeImageTransaction({
  pageId,
  blockId,
  spaceId,
  source,
  fileName,
  sizeText,
  caption,
  width,
  height,
  updateFileIds = true,
  now = Date.now(),
}) {
  const properties = {
    source: [[source]],
    title: [[fileName]],
    size: [[sizeText]],
  };
  if (caption !== undefined) properties.caption = caption ? [[caption]] : [];
  const fileId = attachmentFileId(source);
  const operations = [
    {
      pointer: blockPointer(blockId, spaceId),
      path: ['properties'],
      command: 'update',
      args: properties,
    },
    {
      pointer: blockPointer(blockId, spaceId),
      path: ['format'],
      command: 'update',
      args: {
        block_width: Math.min(width, 700),
        block_height: Math.min(height, 400),
        block_aspect_ratio: height / width,
        block_preserve_scale: false,
        block_full_width: false,
        block_page_width: false,
      },
    },
    {
      pointer: blockPointer(blockId, spaceId),
      path: [],
      command: 'update',
      args: {
        ...(fileId && updateFileIds ? { file_ids: [fileId] } : {}),
        last_edited_time: now,
      },
    },
    touchOperation(pageId, spaceId, now),
  ];
  return buildTransaction(spaceId, operations, 'webcmd.notion.image-add.finalize');
}

export function buildRemoveBlockTransaction({ pageId, blockId, spaceId, now = Date.now() }) {
  return buildTransaction(spaceId, [
    {
      pointer: blockPointer(blockId, spaceId),
      path: [],
      command: 'update',
      args: { alive: false, last_edited_time: now },
    },
    {
      pointer: blockPointer(pageId, spaceId),
      path: ['content'],
      command: 'listRemove',
      args: { id: blockId },
    },
    touchOperation(pageId, spaceId, now),
  ], 'webcmd.notion.image-add.rollback');
}

export function buildUpdateBlockTransaction({ blockId, spaceId, text, now = Date.now() }) {
  const operations = [
    {
      pointer: blockPointer(blockId, spaceId),
      path: ['properties'],
      command: 'update',
      args: { title: [[text]] },
    },
    touchOperation(blockId, spaceId, now),
  ];
  return buildTransaction(spaceId, operations, 'webcmd.notion.block-update');
}

export function buildMoveBlockTransaction({
  parentId,
  blockId,
  afterId,
  spaceId,
  now = Date.now(),
}) {
  if (!afterId) throw new Error('An anchor block ID is required');
  if (blockId === afterId) throw new Error('A block cannot be moved after itself');
  return buildTransaction(spaceId, [
    {
      pointer: blockPointer(parentId, spaceId),
      path: ['content'],
      command: 'listRemove',
      args: { id: blockId },
    },
    {
      pointer: blockPointer(parentId, spaceId),
      path: ['content'],
      command: 'listAfter',
      args: { id: blockId, after: afterId },
    },
    touchOperation(parentId, spaceId, now),
  ], 'webcmd.notion.block-move');
}

export function buildDeleteBlockTransaction({ pageData, blockId, now = Date.now() }) {
  const block = pageData.blocks.find((candidate) => candidate.id === blockId);
  if (!block) throw new Error(`Block not found: ${blockId}`);
  const childrenByParent = new Map();
  for (const candidate of pageData.blocks) {
    if (!childrenByParent.has(candidate.parentID)) childrenByParent.set(candidate.parentID, []);
    childrenByParent.get(candidate.parentID).push(candidate.id);
  }
  const operations = deleteTreeOperations(
    block.id,
    block.parentID,
    pageData.spaceId,
    childrenByParent,
  );
  operations.push(touchOperation(block.parentID, pageData.spaceId, now));
  return buildTransaction(pageData.spaceId, operations, 'webcmd.notion.block-delete');
}

export function buildDuplicateBlockTransaction({
  pageData,
  blockId,
  now = Date.now(),
  idFactory = randomUUID,
}) {
  const source = pageData.blocks.find((candidate) => candidate.id === blockId);
  if (!source) throw new Error(`Block not found: ${blockId}`);
  const tree = blockTreeFromPage(pageData, blockId);
  const inserted = structuredInsertOperations({
    block: tree,
    parentId: source.parentID,
    afterId: source.id,
    spaceId: pageData.spaceId,
    now,
    idFactory,
  });
  inserted.operations.push(touchOperation(source.parentID, pageData.spaceId, now));
  return {
    blockId: inserted.id,
    insertedIds: inserted.ids,
    payload: buildTransaction(pageData.spaceId, inserted.operations, 'webcmd.notion.block-duplicate'),
  };
}

export function buildReparentBlockTransaction({
  blockId,
  fromParentId,
  toParentId,
  afterId = '',
  spaceId,
  now = Date.now(),
  userAction = 'webcmd.notion.block-reparent',
}) {
  if (blockId === toParentId) throw new Error('A block cannot become its own parent');
  const listArgs = { id: blockId };
  if (afterId) listArgs.after = afterId;
  return buildTransaction(spaceId, [
    {
      pointer: blockPointer(fromParentId, spaceId),
      path: ['content'],
      command: 'listRemove',
      args: { id: blockId },
    },
    {
      pointer: blockPointer(blockId, spaceId),
      path: [],
      command: 'update',
      args: { parent_id: toParentId, parent_table: 'block', alive: true, last_edited_time: now },
    },
    {
      pointer: blockPointer(toParentId, spaceId),
      path: ['content'],
      command: 'listAfter',
      args: listArgs,
    },
    touchOperation(fromParentId, spaceId, now),
    touchOperation(toParentId, spaceId, now),
  ], userAction);
}

export function buildPageArchiveTransaction({ pageId, parentId, spaceId, userId = '', now = Date.now() }) {
  const editor = userId ? {
    last_edited_by_id: userId,
    last_edited_by_table: 'notion_user',
  } : {};
  return buildTransaction(spaceId, [
    {
      pointer: blockPointer(parentId, spaceId),
      path: ['content'],
      command: 'removeChild',
      args: { id: pageId },
      additionalUpdatedPointers: [
        blockPointer(parentId, spaceId),
        blockPointer(pageId, spaceId),
      ],
    },
    {
      pointer: blockPointer(parentId, spaceId),
      path: [],
      command: 'update',
      args: { last_edited_time: now, ...editor },
    },
    {
      pointer: blockPointer(pageId, spaceId),
      path: [],
      command: 'update',
      args: { last_edited_time: now, ...editor },
    },
  ], 'webcmd.notion.page-archive');
}

export function buildPageRestoreTransaction({
  pageId,
  parentId,
  afterId = '',
  spaceId,
  now = Date.now(),
}) {
  const listArgs = { id: pageId };
  if (afterId) listArgs.after = afterId;
  return buildTransaction(spaceId, [
    {
      pointer: blockPointer(pageId, spaceId),
      path: [],
      command: 'update',
      args: {
        alive: true,
        parent_id: parentId,
        parent_table: 'block',
        last_edited_time: now,
      },
    },
    {
      pointer: blockPointer(parentId, spaceId),
      path: ['content'],
      command: 'listAfter',
      args: listArgs,
    },
    touchOperation(parentId, spaceId, now),
  ], 'webcmd.notion.page-restore');
}

export function buildCreatePageTransaction({ parentId, spaceId, afterId = '', title, content = '', now = Date.now(), pageId = randomUUID(), blockId = randomUUID() }) {
  const operations = insertOperations({
    id: pageId,
    parentId,
    afterId,
    spaceId,
    type: 'page',
    text: title,
    now,
  });
  if (content) {
    operations.push(...insertOperations({
      id: blockId,
      parentId: pageId,
      afterId: '',
      spaceId,
      type: 'text',
      text: content,
      now,
    }));
  }
  operations.push(touchOperation(parentId, spaceId, now));
  return {
    pageId,
    blockId: content ? blockId : '',
    payload: buildTransaction(spaceId, operations, 'webcmd.notion.create'),
  };
}

export function buildDuplicatePageTransaction({
  pageData,
  parentId,
  afterId = '',
  title = '',
  now = Date.now(),
  idFactory = randomUUID,
}) {
  const root = pageData.records?.[pageData.id];
  if (!root) throw new Error(`Page record not found: ${pageData.id}`);
  const tree = blockTreeFromPage(pageData, pageData.id);
  if (title) tree.properties.title = [[title]];
  const inserted = structuredInsertOperations({
    block: tree,
    parentId,
    afterId,
    spaceId: pageData.spaceId,
    now,
    idFactory,
  });
  inserted.operations.push(touchOperation(parentId, pageData.spaceId, now));
  return {
    pageId: inserted.id,
    insertedIds: inserted.ids,
    payload: buildTransaction(pageData.spaceId, inserted.operations, 'webcmd.notion.page-duplicate'),
  };
}

export function buildAppendFilePlaceholderTransaction({
  pageId,
  spaceId,
  afterId = '',
  fileName,
  sizeText,
  now = Date.now(),
  blockId = randomUUID(),
}) {
  const operations = [
    {
      pointer: blockPointer(blockId, spaceId),
      path: [],
      command: 'set',
      args: {
        id: blockId,
        parent_id: pageId,
        parent_table: 'block',
        alive: true,
        created_time: now,
        last_edited_time: now,
        space_id: spaceId,
        type: 'file',
        properties: { title: [[fileName]], size: [[sizeText]] },
      },
    },
    {
      pointer: blockPointer(pageId, spaceId),
      path: ['content'],
      command: 'listAfter',
      args: afterId ? { id: blockId, after: afterId } : { id: blockId },
    },
    touchOperation(pageId, spaceId, now),
  ];
  return {
    blockId,
    payload: buildTransaction(spaceId, operations, 'webcmd.notion.file-add.placeholder'),
  };
}

export function buildFinalizeFileTransaction({
  pageId,
  blockId,
  spaceId,
  source,
  fileName,
  sizeText,
  caption,
  now = Date.now(),
}) {
  const properties = {
    source: [[source]],
    title: [[fileName]],
    size: [[sizeText]],
  };
  if (caption !== undefined) properties.caption = caption ? [[caption]] : [];
  const fileId = attachmentFileId(source);
  return buildTransaction(spaceId, [
    {
      pointer: blockPointer(blockId, spaceId),
      path: ['properties'],
      command: 'update',
      args: properties,
    },
    {
      pointer: blockPointer(blockId, spaceId),
      path: [],
      command: 'update',
      args: {
        ...(fileId ? { file_ids: [fileId] } : {}),
        last_edited_time: now,
      },
    },
    touchOperation(pageId, spaceId, now),
  ], 'webcmd.notion.file-add.finalize');
}

export function buildReplaceBlocksTransaction({
  pageId,
  spaceId,
  existingBlocks = [],
  blocks,
  now = Date.now(),
  idFactory = randomUUID,
}) {
  const childrenByParent = new Map();
  for (const block of existingBlocks) {
    if (!childrenByParent.has(block.parentID)) childrenByParent.set(block.parentID, []);
    childrenByParent.get(block.parentID).push(block.id);
  }

  const operations = [];
  for (const id of childrenByParent.get(pageId) || []) {
    operations.push(...deleteTreeOperations(id, pageId, spaceId, childrenByParent));
  }

  const insertedIds = [];
  const rootIds = [];
  let afterId = '';
  for (const block of blocks) {
    const inserted = structuredInsertOperations({
      block,
      parentId: pageId,
      afterId,
      spaceId,
      now,
      idFactory,
    });
    operations.push(...inserted.operations);
    insertedIds.push(...inserted.ids);
    rootIds.push(inserted.id);
    afterId = inserted.id;
  }
  operations.push(touchOperation(pageId, spaceId, now));
  return {
    insertedIds,
    rootIds,
    payload: buildTransaction(spaceId, operations, 'webcmd.notion.markdown-set'),
  };
}

export async function loadPageChunk(page, pageId, limit = 500) {
  if (typeof page.fetchJson !== 'function') {
    throw new Error('This Webcmd runtime does not support browser-session JSON requests');
  }
  const id = notionId(pageId);
  if (!id) throw new Error('A valid Notion page ID is required');
  const payload = await page.fetchJson(`${API_ROOT}/loadPageChunk`, {
    method: 'POST',
    headers: { 'notion-audit-log-platform': 'web' },
    body: {
      pageId: id,
      limit,
      cursor: { stack: [] },
      chunkNumber: 0,
      verticalColumns: false,
    },
  });
  const rootEntry = payload?.recordMap?.block?.[id];
  const root = unwrapRecord(rootEntry);
  const spaceId = root?.space_id || rootEntry?.spaceId || rootEntry?.value?.spaceId || '';
  for (let round = 0; round < 10; round += 1) {
    const rawBlocks = payload?.recordMap?.block || {};
    const known = new Set(Object.keys(rawBlocks).map((blockId) => notionId(blockId) || blockId));
    const missing = [...new Set(Object.values(rawBlocks)
      .map(unwrapRecord)
      .filter(Boolean)
      .flatMap((block) => block.content || [])
      .map((blockId) => notionId(blockId) || blockId)
      .filter((blockId) => blockId && !known.has(blockId)))];
    if (!missing.length) break;
    const synced = await page.fetchJson(`${API_ROOT}/syncRecordValues`, {
      method: 'POST',
      headers: {
        'notion-audit-log-platform': 'web',
        ...(spaceId ? { 'x-notion-space-id': spaceId } : {}),
      },
      body: {
        requests: missing.map((blockId) => ({
          pointer: blockPointer(blockId, spaceId),
          version: -1,
        })),
      },
    });
    const syncedBlocks = synced?.recordMap?.block || {};
    if (!Object.keys(syncedBlocks).length) break;
    Object.assign(payload.recordMap.block, syncedBlocks);
  }
  const syncMissingRecords = async (table, ids) => {
    const records = payload?.recordMap?.[table] || {};
    const known = new Set(Object.keys(records).map((recordId) => notionId(recordId) || recordId));
    const missing = [...new Set(ids.map((recordId) => notionId(recordId) || recordId)
      .filter((recordId) => recordId && !known.has(recordId)))];
    if (!missing.length) return;
    const synced = await page.fetchJson(`${API_ROOT}/syncRecordValues`, {
      method: 'POST',
      headers: {
        'notion-audit-log-platform': 'web',
        ...(spaceId ? { 'x-notion-space-id': spaceId } : {}),
      },
      body: {
        requests: missing.map((recordId) => ({
          pointer: { table, id: recordId, spaceId },
          version: -1,
        })),
      },
    });
    payload.recordMap[table] ||= {};
    Object.assign(payload.recordMap[table], synced?.recordMap?.[table] || {});
    for (const [recordTable, entries] of Object.entries(synced?.recordMap || {})) {
      if (recordTable === '__version__' || !entries || typeof entries !== 'object') continue;
      payload.recordMap[recordTable] ||= {};
      Object.assign(payload.recordMap[recordTable], entries);
    }
  };
  const discussionRecords = Object.values(payload?.recordMap?.discussion || {}).map(unwrapRecord).filter(Boolean);
  await syncMissingRecords('comment', discussionRecords.flatMap((discussion) => discussion.comments || []));
  const commentRecords = Object.values(payload?.recordMap?.comment || {}).map(unwrapRecord).filter(Boolean);
  await syncMissingRecords('notion_user', commentRecords.map((comment) => comment.created_by_id));
  return parsePageChunk(payload, id, limit);
}

export async function saveTransaction(page, spaceId, payload) {
  if (typeof page.fetchJson !== 'function') {
    throw new Error('This Webcmd runtime does not support browser-session JSON requests');
  }
  return page.fetchJson(`${API_ROOT}/saveTransactionsFanout`, {
    method: 'POST',
    headers: {
      'notion-audit-log-platform': 'web',
      'x-notion-space-id': spaceId,
    },
    body: payload,
  });
}

export async function getUploadSpaceFileUrl(page, {
  spaceId,
  blockId,
  fileName,
  contentType,
  contentLength,
}) {
  if (typeof page.fetchJson !== 'function') {
    throw new Error('This Webcmd runtime does not support browser-session JSON requests');
  }
  const result = await page.fetchJson(`${API_ROOT}/getUploadSpaceFileUrl`, {
    method: 'POST',
    headers: {
      'notion-audit-log-platform': 'web',
      'x-notion-space-id': spaceId,
    },
    body: {
      bucket: 'secure',
      name: fileName,
      contentType,
      record: { table: 'block', id: blockId, spaceId },
      supportExtraHeaders: true,
      contentLength,
      spaceId,
    },
  });
  if (result?.type !== 'PUT' || !result.url || !result.signedPutUrl) {
    throw new Error('getUploadSpaceFileUrl returned an unsupported response');
  }
  return result;
}

export async function uploadSignedFile(upload, bytes, contentType, fetchImpl = fetch) {
  const headers = new Headers();
  for (const header of upload.putHeaders || []) {
    if (header?.name && header?.value != null) headers.set(header.name, String(header.value));
  }
  headers.set('Content-Type', contentType);
  const response = await fetchImpl(upload.signedPutUrl, {
    method: 'PUT',
    headers,
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`Signed upload failed with HTTP ${response.status}`);
  }
}

export async function getSignedFileUrl(page, { source, blockId, spaceId }) {
  if (typeof page.fetchJson !== 'function') {
    throw new Error('This Webcmd runtime does not support browser-session JSON requests');
  }
  const result = await page.fetchJson(`${API_ROOT}/getSignedFileUrls`, {
    method: 'POST',
    headers: {
      'notion-audit-log-platform': 'web',
      'x-notion-space-id': spaceId,
    },
    body: {
      urls: [{
        url: source,
        permissionRecord: { table: 'block', id: blockId, spaceId },
      }],
    },
  });
  const signedUrl = result?.signedUrls?.[0];
  if (!signedUrl) throw new Error('getSignedFileUrls returned no signed URL');
  return signedUrl;
}

export async function restorePageRecord(page, { pageId, spaceId }) {
  if (typeof page.fetchJson !== 'function') {
    throw new Error('This Webcmd runtime does not support browser-session JSON requests');
  }
  return page.fetchJson(`${API_ROOT}/restoreRecord`, {
    method: 'POST',
    headers: {
      'notion-audit-log-platform': 'web',
      'x-notion-space-id': spaceId,
    },
    body: {
      pointer: { table: 'block', id: pageId, spaceId },
      deletedFromTrashRestorationOption: 'restore_original_access',
    },
  });
}

export async function deleteContentRecords(page, { pageId, spaceId }) {
  if (typeof page.fetchJson !== 'function') {
    throw new Error('This Webcmd runtime does not support browser-session JSON requests');
  }
  return page.fetchJson(`${API_ROOT}/deleteContentRecords`, {
    method: 'POST',
    headers: {
      'notion-audit-log-platform': 'web',
      'x-notion-space-id': spaceId,
    },
    body: {
      records: [{ id: pageId, table: 'block', spaceId }],
      permanentlyDelete: false,
    },
  });
}

export async function downloadSignedFile(signedUrl, fetchImpl = fetch) {
  const response = await fetchImpl(signedUrl);
  if (!response.ok) throw new Error(`Signed download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function downloadSignedFileViaPage(page, signedUrl) {
  if (typeof page.evaluateWithArgs !== 'function') {
    throw new Error('This Webcmd runtime does not support browser-session binary requests');
  }
  const result = await page.evaluateWithArgs(`
    (async () => {
      const response = await fetch(downloadUrl, { credentials: 'include' });
      if (!response.ok) return { ok: false, status: response.status };
      const bytes = new Uint8Array(await response.arrayBuffer());
      const chunks = [];
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
      }
      return { ok: true, base64: btoa(chunks.join('')), size: bytes.length };
    })()
  `, { downloadUrl: signedUrl });
  if (!result?.ok || typeof result.base64 !== 'string') {
    throw new Error(`Signed browser download failed with HTTP ${result?.status ?? 0}`);
  }
  return Buffer.from(result.base64, 'base64');
}

export function pageUrl(pageId) {
  return `https://www.notion.so/${String(pageId).replaceAll('-', '')}`;
}
