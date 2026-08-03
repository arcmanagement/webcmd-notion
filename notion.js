import fs from 'node:fs';
import path from 'node:path';
import { imageSize } from 'image-size';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '@agentrhq/webcmd/errors';
import { cli, Strategy } from '@agentrhq/webcmd/registry';
import { buildExtractScript } from './lib/notion-dom-parser.mjs';
import { parseBatchDocument } from './lib/notion-batch.mjs';
import {
  buildCommentAddTransaction,
  buildCommentResolveTransaction,
  commentRows,
  loadCurrentNotionUser,
} from './lib/notion-comments.mjs';
import {
  decodeDatabasePropertyValue,
  buildDatabaseRowCreateTransaction,
  buildDatabaseRowDeleteTransaction,
  buildDatabaseRowUpdateTransaction,
  databaseSchemaRows,
  encodeDatabaseProperties,
  filterDatabaseRows,
  findDatabase,
  queryDatabase,
  sortDatabaseRows,
} from './lib/notion-database.mjs';
import { buildButtonProbeScript, buttonProbeError } from './lib/notion-button.mjs';
import { diffNotionBlocks } from './lib/notion-diff.mjs';
import {
  buildAppendBlockTransaction,
  buildAppendFilePlaceholderTransaction,
  buildAppendImagePlaceholderTransaction,
  buildAppendStructuredBlocksTransaction,
  buildCreatePageTransaction,
  buildDeleteBlockTransaction,
  buildDuplicateBlockTransaction,
  buildFinalizeFileTransaction,
  buildFinalizeImageTransaction,
  buildMoveBlockTransaction,
  buildPageArchiveTransaction,
  buildPageRestoreTransaction,
  buildReparentBlockTransaction,
  buildRemoveBlockTransaction,
  buildReplaceBlocksTransaction,
  buildUpdateBlockTransaction,
  deleteContentRecords,
  downloadSignedFileViaPage,
  getSignedFileUrl,
  getUploadSpaceFileUrl,
  INTERNAL_API_CHANGE_HINT,
  loadPageChunk,
  notionId,
  pageUrl,
  restorePageRecord,
  saveTransaction,
  uploadSignedFile,
} from './lib/notion-internal-api.mjs';
import { markdownToNotionBlocks, summarizeNotionBlocks } from './lib/notion-markdown.mjs';
import {
  buildDuplicateSubtreeTask,
  buildExportTask,
  duplicatedPageFromTask,
  enqueueNotionTask,
  exportUrlFromTask,
  waitForNotionTask,
} from './lib/notion-tasks.mjs';

const NOTION_HOME = 'https://app.notion.com/';
const NOTION_LOGIN = 'https://www.notion.com/login';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const IMAGE_CONTENT_TYPES = {
  gif: 'image/gif',
  heic: 'image/heic',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

const FILE_CONTENT_TYPES = {
  ...IMAGE_CONTENT_TYPES,
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  json: 'application/json',
  md: 'text/markdown',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readImageFile(value) {
  const file = path.resolve(String(value ?? ''));
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw new ArgumentError(`Image file could not be read: ${error instanceof Error ? error.message : error}`);
  }
  let dimensions;
  try {
    dimensions = imageSize(bytes);
  } catch (error) {
    throw new ArgumentError(`Image metadata could not be read: ${error instanceof Error ? error.message : error}`);
  }
  const type = String(dimensions.type || path.extname(file).slice(1)).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[type];
  if (!contentType || !dimensions.width || !dimensions.height) {
    throw new ArgumentError(`Unsupported image type or dimensions: ${type || 'unknown'}`);
  }
  return {
    file,
    fileName: path.basename(file),
    bytes,
    contentType,
    width: dimensions.width,
    height: dimensions.height,
    sizeText: formatFileSize(bytes.length),
  };
}

function readLocalFile(value) {
  const file = path.resolve(String(value ?? ''));
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw new ArgumentError(`File could not be read: ${error instanceof Error ? error.message : error}`);
  }
  if (!bytes.length) throw new ArgumentError('File is empty');
  const extension = path.extname(file).slice(1).toLowerCase();
  return {
    file,
    fileName: path.basename(file),
    bytes,
    contentType: FILE_CONTENT_TYPES[extension] || 'application/octet-stream',
    sizeText: formatFileSize(bytes.length),
  };
}

function writeOutputFile(outputValue, bytes, { force = false, defaultName }) {
  const output = path.resolve(String(outputValue || defaultName));
  if (fs.existsSync(output) && force !== true) {
    throw new ArgumentError(`Output already exists: ${output}. Use --force to overwrite it.`);
  }
  const temporary = `${output}.webcmd-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    if (force === true && fs.existsSync(output)) fs.rmSync(output);
    fs.renameSync(temporary, output);
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.rmSync(temporary);
    } catch {}
    throw new CommandExecutionError(`Output file could not be written: ${error instanceof Error ? error.message : error}`);
  }
  return output;
}

function requireConfirmation(value, operation) {
  if (value !== true) {
    throw new ArgumentError(`${operation} requires --yes`);
  }
}

function parseJsonObject(value, label) {
  if (value == null || value === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch (error) {
    throw new ArgumentError(`${label} must be valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ArgumentError(`${label} must be a JSON object`);
  }
  return parsed;
}

function parseJsonValue(value, label) {
  if (value == null || value === '') return null;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new ArgumentError(`${label} must be valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function resolveDatabaseRow(rows, value) {
  const requested = String(value ?? '').trim();
  const id = notionId(requested);
  if (id) {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new ArgumentError(`Database row not found: ${requested}`);
    return row;
  }
  const index = Number(requested);
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) {
    throw new ArgumentError(`Database row index must be from 0 to ${Math.max(0, rows.length - 1)}`);
  }
  return rows[index];
}

async function databaseContext(page, value) {
  const target = await internalPage(page, value);
  const url = notionUrlFrom(value, true);
  const database = findDatabase(target, url.searchParams.get('v') || '');
  return {
    target,
    database,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
}

function unwrapEvaluateResult(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

function limitFrom(value, maximum = MAX_LIMIT) {
  const limit = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new ArgumentError(`limit must be an integer from 1 to ${maximum}`);
  }
  return limit;
}

function notionUrlFrom(value, required = false) {
  const raw = String(value ?? '').trim();
  if (!raw && !required) return new URL(NOTION_HOME);
  if (!raw) throw new ArgumentError('A Notion URL is required');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ArgumentError('Notion URL must be an absolute https URL');
  }
  const host = url.hostname.toLowerCase();
  const validHost = host === 'notion.so'
    || host.endsWith('.notion.so')
    || host === 'notion.com'
    || host.endsWith('.notion.com')
    || host === 'notion.site'
    || host.endsWith('.notion.site');
  if (url.protocol !== 'https:' || !validHost) {
    throw new ArgumentError('Notion URL must use an https://notion.com, https://notion.so, or https://notion.site host');
  }
  return url;
}

async function extract(page, operation, limit = DEFAULT_LIMIT) {
  const raw = unwrapEvaluateResult(await page.evaluate(buildExtractScript(operation, { limit })));
  if (!raw || raw.ok !== true) {
    const message = raw && typeof raw === 'object' && 'error' in raw
      ? raw.error
      : 'Notion parser returned an invalid result';
    throw new CommandExecutionError(
      String(message),
      'Notion HTML may have changed. Update the plugin parser and its fixtures before retrying.',
    );
  }
  return raw.value;
}

async function currentState(page) {
  return extract(page, 'page', 1);
}

async function requireLogin(page) {
  const state = await currentState(page);
  if (state.authRequired || !state.appVisible) {
    throw new AuthRequiredError(
      'www.notion.com',
      'Notion login is required for this Webcmd profile. Run notion login with --window foreground.',
    );
  }
  return state;
}

async function prepareInternalSession(page) {
  await navigateNotion(page, NOTION_HOME);
  await requireLogin(page);
}

function requirePageId(value) {
  const id = notionId(value);
  if (!id) throw new ArgumentError('A Notion page URL or page ID is required');
  return id;
}

async function internalPage(page, value, limit = 500) {
  const id = requirePageId(value);
  try {
    return await loadPageChunk(page, id, limit);
  } catch (error) {
    throw new CommandExecutionError(
      `Notion internal page request failed: ${error instanceof Error ? error.message : error}`,
      INTERNAL_API_CHANGE_HINT,
    );
  }
}

async function sendInternalTransaction(page, spaceId, payload, operation) {
  if (!spaceId) {
    throw new CommandExecutionError(
      `Notion did not return a workspace ID for ${operation}`,
      INTERNAL_API_CHANGE_HINT,
    );
  }
  try {
    await saveTransaction(page, spaceId, payload);
  } catch (error) {
    throw new CommandExecutionError(
      `Notion internal ${operation} request failed: ${error instanceof Error ? error.message : error}`,
      INTERNAL_API_CHANGE_HINT,
    );
  }
}

async function waitForInternalPage(page, pageId, predicate, seconds = 8) {
  const deadline = Date.now() + seconds * 1000;
  let latest;
  do {
    latest = await internalPage(page, pageId);
    if (predicate(latest)) return latest;
    await page.sleep(0.25);
  } while (Date.now() < deadline);
  throw new TimeoutError('Notion internal write verification', seconds);
}

async function waitForDatabase(page, options, predicate, seconds = 8) {
  const deadline = Date.now() + seconds * 1000;
  let latest;
  do {
    latest = await queryDatabase(page, options);
    if (predicate(latest)) return latest;
    await page.sleep(0.25);
  } while (Date.now() < deadline);
  throw new TimeoutError('Notion database write verification', seconds);
}

function resolveBlock(pageData, value) {
  const requested = String(value ?? '').trim();
  if (!requested) throw new ArgumentError('A block ID or zero-based block index is required');
  const id = notionId(requested);
  if (id) {
    const block = pageData.blocks.find((candidate) => candidate.id === id);
    if (!block) throw new ArgumentError(`Block not found in page: ${requested}`);
    return block;
  }
  const index = Number(requested);
  if (!Number.isInteger(index) || index < 0 || index >= pageData.blocks.length) {
    throw new ArgumentError(`Block index must be from 0 to ${Math.max(0, pageData.blocks.length - 1)}`);
  }
  return pageData.blocks[index];
}

async function runBatchOperation(page, url, operation, allowDestructive) {
  const target = await internalPage(page, url);
  const args = operation.args;
  if (operation.command === 'block-add') {
    const transaction = buildAppendBlockTransaction({
      pageId: target.id,
      spaceId: target.spaceId,
      afterId: target.content.at(-1) || '',
      text: args.text,
      type: args.type || 'paragraph',
    });
    await sendInternalTransaction(page, target.spaceId, transaction.payload, 'batch block append');
    await waitForInternalPage(page, target.id, (result) => result.blocks.some((block) => block.id === transaction.blockId));
    return { blockID: transaction.blockId };
  }
  if (operation.command === 'block-update') {
    const block = resolveBlock(target, args.block);
    const payload = buildUpdateBlockTransaction({ blockId: block.id, spaceId: target.spaceId, text: args.text });
    await sendInternalTransaction(page, target.spaceId, payload, 'batch block update');
    await waitForInternalPage(page, target.id, (result) => result.blocks.some((candidate) => candidate.id === block.id && candidate.text === args.text));
    return { blockID: block.id };
  }
  if (operation.command === 'block-move') {
    const block = resolveBlock(target, args.block);
    const anchor = resolveBlock(target, args.after);
    if (block.parentID !== target.id || anchor.parentID !== target.id) throw new Error('batch block-move supports top-level blocks only');
    const payload = buildMoveBlockTransaction({
      parentId: target.id,
      blockId: block.id,
      afterId: anchor.id,
      spaceId: target.spaceId,
    });
    await sendInternalTransaction(page, target.spaceId, payload, 'batch block move');
    await waitForInternalPage(page, target.id, (result) => result.content.indexOf(block.id) === result.content.indexOf(anchor.id) + 1);
    return { blockID: block.id, afterID: anchor.id };
  }
  if (operation.command === 'block-delete') {
    if (!allowDestructive) throw new Error('batch block-delete requires --allow-destructive');
    const block = resolveBlock(target, args.block);
    const payload = buildDeleteBlockTransaction({ pageData: target, blockId: block.id });
    await sendInternalTransaction(page, target.spaceId, payload, 'batch block deletion');
    await waitForInternalPage(page, target.id, (result) => !result.blocks.some((candidate) => candidate.id === block.id));
    return { blockID: block.id, deleted: true };
  }
  if (operation.command === 'block-duplicate') {
    const block = resolveBlock(target, args.block);
    const transaction = buildDuplicateBlockTransaction({ pageData: target, blockId: block.id });
    await sendInternalTransaction(page, target.spaceId, transaction.payload, 'batch block duplication');
    await waitForInternalPage(page, target.id, (result) => result.blocks.some((candidate) => candidate.id === transaction.blockId));
    return { sourceBlockID: block.id, blockID: transaction.blockId };
  }
  if (operation.command === 'block-indent') {
    const block = resolveBlock(target, args.block);
    const siblings = target.records?.[block.parentID]?.content || [];
    const position = siblings.indexOf(block.id);
    if (position <= 0) throw new Error('The first sibling cannot be indented');
    const parentId = notionId(siblings[position - 1]) || siblings[position - 1];
    const payload = buildReparentBlockTransaction({
      blockId: block.id,
      fromParentId: block.parentID,
      toParentId: parentId,
      afterId: target.records?.[parentId]?.content?.at(-1) || '',
      spaceId: target.spaceId,
      userAction: 'webcmd.notion.batch.block-indent',
    });
    await sendInternalTransaction(page, target.spaceId, payload, 'batch block indent');
    await waitForInternalPage(page, target.id, (result) => result.blocks.some((candidate) => candidate.id === block.id && candidate.parentID === parentId));
    return { blockID: block.id, parentID: parentId };
  }
  if (operation.command === 'block-outdent') {
    const block = resolveBlock(target, args.block);
    if (block.parentID === target.id) throw new Error('The block is already top-level');
    const parent = target.records?.[block.parentID];
    const grandparentId = notionId(parent?.parent_id) || parent?.parent_id || '';
    if (!grandparentId) throw new Error('The parent block has no movable parent');
    const payload = buildReparentBlockTransaction({
      blockId: block.id,
      fromParentId: block.parentID,
      toParentId: grandparentId,
      afterId: block.parentID,
      spaceId: target.spaceId,
      userAction: 'webcmd.notion.batch.block-outdent',
    });
    await sendInternalTransaction(page, target.spaceId, payload, 'batch block outdent');
    await waitForInternalPage(page, target.id, (result) => result.blocks.some((candidate) => candidate.id === block.id && candidate.parentID === grandparentId));
    return { blockID: block.id, parentID: grandparentId };
  }
  if (operation.command === 'markdown-append') {
    const markdown = fs.readFileSync(args.file, 'utf8');
    const blocks = markdownToNotionBlocks(markdown);
    if (!blocks.length) throw new Error('Markdown file produced no Notion blocks');
    const transaction = buildAppendStructuredBlocksTransaction({
      pageId: target.id,
      spaceId: target.spaceId,
      afterId: target.content.at(-1) || '',
      blocks,
      userAction: 'webcmd.notion.batch.markdown-append',
    });
    await sendInternalTransaction(page, target.spaceId, transaction.payload, 'batch Markdown append');
    await waitForInternalPage(page, target.id, (result) => transaction.insertedIds.every((id) => result.blocks.some((block) => block.id === id)));
    return { blockIDs: transaction.rootIds };
  }
  if (operation.command === 'rename') {
    const payload = buildUpdateBlockTransaction({ blockId: target.id, spaceId: target.spaceId, text: args.title });
    await sendInternalTransaction(page, target.spaceId, payload, 'batch page rename');
    await waitForInternalPage(page, target.id, (result) => result.title === args.title);
    return { pageID: target.id, title: args.title };
  }
  throw new Error(`Unsupported batch command: ${operation.command}`);
}

async function navigateNotion(page, value, { requireUrl = false, requireAuth = true } = {}) {
  const url = notionUrlFrom(value, requireUrl);
  try {
    await page.goto(url.href, { waitUntil: 'none', settleMs: 900 });
  } catch (error) {
    throw new CommandExecutionError(`Notion navigation failed: ${error instanceof Error ? error.message : error}`);
  }
  if (requireAuth) await waitForNotion(page);
  return url;
}

async function waitForNotion(page, seconds = 15) {
  const deadline = Date.now() + seconds * 1000;
  do {
    const state = await currentState(page);
    if (state.authRequired) {
      throw new AuthRequiredError('www.notion.com', 'Notion login expired for this Webcmd profile.');
    }
    if (state.appVisible) return state;
    await page.sleep(0.25);
  } while (Date.now() < deadline);
  throw new TimeoutError('Notion application', seconds);
}

async function openWorkspaceMenu(page) {
  const alreadyOpen = unwrapEvaluateResult(await page.evaluate(`(() =>
    Boolean(Array.from(document.querySelectorAll('[role="menu"], [role="dialog"]'))
      .find((node) => node.querySelector('[role="menuitem"]')))
  )()`));
  if (alreadyOpen) return;

  const prepared = unwrapEvaluateResult(await page.evaluate(`(() => {
    const candidates = Array.from(document.querySelectorAll('nav [role="button"][aria-haspopup="dialog"], nav [role="button"]'));
    const trigger = candidates.find((node) => {
      const text = (node.innerText || node.textContent || '').trim();
      return text && text.length <= 160 && !/help|ヘルプ|新機能|検索/.test(text);
    });
    if (!trigger) return false;
    trigger.setAttribute('data-webcmd-notion-workspace-trigger', 'true');
    return true;
  })()`));
  if (!prepared) {
    throw new CommandExecutionError(
      'Notion workspace switcher was not found',
      'Notion HTML may have changed. Update the plugin parser and its fixtures before retrying.',
    );
  }
  await page.click('[data-webcmd-notion-workspace-trigger="true"]');
  await page.wait({ selector: '[role="menu"] [role="menuitem"], [role="dialog"] [role="menuitem"]', timeout: 10 });
}

async function workspaceRows(page, limit = DEFAULT_LIMIT) {
  await openWorkspaceMenu(page);
  const rows = await extract(page, 'workspaces', limit);
  if (!Array.isArray(rows) || rows.length === 0) {
    await page.pressKey('Escape').catch(() => {});
    throw new EmptyResultError('notion workspaces', 'Notion reported no available workspaces.');
  }
  return rows;
}

const URL_ARG = {
  name: 'url',
  positional: true,
  required: true,
  help: 'Notion page or workspace URL',
};

const OPTIONAL_URL_ARG = {
  ...URL_ARG,
  required: false,
};

const LIMIT_ARG = {
  name: 'limit',
  type: 'int',
  default: DEFAULT_LIMIT,
  help: `Maximum number of rows, 1-${MAX_LIMIT}`,
};

const SEARCH_LIMIT_ARG = {
  ...LIMIT_ARG,
  default: 20,
  help: 'Maximum number of search results, 1-50',
};

function registerRowsCommand({ name, operation, description, columns, urlRequired = false }) {
  cli({
    site: 'notion',
    name,
    access: 'read',
    description,
    domain: 'www.notion.so',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    siteSession: 'persistent',
    defaultFormat: 'json',
    args: [urlRequired ? URL_ARG : OPTIONAL_URL_ARG, LIMIT_ARG],
    columns,
    func: async (page, kwargs) => {
      const limit = limitFrom(kwargs.limit);
      await navigateNotion(page, kwargs.url, { requireUrl: urlRequired });
      const rows = await extract(page, operation, limit);
      if (!Array.isArray(rows)) {
        throw new CommandExecutionError(`Notion ${operation} parser returned a non-list result`);
      }
      if (rows.length === 0) {
        throw new EmptyResultError(`notion ${name}`, 'Notion reported a recognized empty result.');
      }
      return rows;
    },
  });
}

cli({
  site: 'notion',
  name: 'login',
  access: 'write',
  description: 'Open Notion sign-in in the selected Webcmd profile',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [OPTIONAL_URL_ARG],
  columns: ['status', 'url', 'action', 'verifyCommand'],
  func: async (page, kwargs) => {
    const url = kwargs.url ? notionUrlFrom(kwargs.url, false) : new URL(NOTION_LOGIN);
    await page.goto(url.href, { waitUntil: 'none', settleMs: 900 });
    return [{
      status: 'action_required',
      url: url.href,
      action: 'Complete sign-in in the foreground Webcmd browser.',
      verifyCommand: 'webcmd --profile <profile> notion whoami',
    }];
  },
});

cli({
  site: 'notion',
  name: 'whoami',
  access: 'read',
  description: 'Check the current Notion login and workspace',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [],
  columns: ['loggedIn', 'workspaceName', 'title', 'url'],
  func: async (page) => {
    await navigateNotion(page, NOTION_HOME);
    const state = await requireLogin(page);
    return [{
      loggedIn: true,
      workspaceName: state.workspaceName,
      title: state.title,
      url: state.url,
    }];
  },
});

cli({
  site: 'notion',
  name: 'page',
  access: 'read',
  description: 'Inspect a Notion page and authentication state',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [OPTIONAL_URL_ARG],
  columns: ['title', 'url', 'authRequired', 'appVisible', 'pageVisible', 'workspaceName'],
  func: async (page, kwargs) => {
    await navigateNotion(page, kwargs.url);
    return [await currentState(page)];
  },
});

cli({
  site: 'notion',
  name: 'read',
  access: 'read',
  description: 'Read a Notion page through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [URL_ARG, LIMIT_ARG],
  columns: ['title', 'url', 'text', 'blocks'],
  func: async (page, kwargs) => {
    const limit = limitFrom(kwargs.limit);
    await prepareInternalSession(page);
    const result = await internalPage(page, kwargs.url, limit);
    if (!result.text && result.blocks.length === 0) {
      throw new EmptyResultError('notion read', 'Notion reported a recognized empty page.');
    }
    return [{
      id: result.id,
      title: result.title,
      url: notionUrlFrom(kwargs.url, true).href,
      text: result.text,
      blocks: result.blocks,
      source: 'internal_api',
    }];
  },
});

cli({
  site: 'notion',
  name: 'blocks',
  access: 'read',
  description: 'List Notion page blocks through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [URL_ARG, LIMIT_ARG],
  columns: ['index', 'id', 'type', 'text', 'depth', 'parentID'],
  func: async (page, kwargs) => {
    const limit = limitFrom(kwargs.limit);
    await prepareInternalSession(page);
    const result = await internalPage(page, kwargs.url, limit);
    if (!result.blocks.length) {
      throw new EmptyResultError('notion blocks', 'Notion reported a recognized empty page.');
    }
    return result.blocks;
  },
});

cli({
  site: 'notion',
  name: 'create',
  access: 'write',
  description: 'Create a child page through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    { name: 'parent', positional: true, required: true, help: 'Parent Notion page URL or ID' },
    { name: 'title', positional: true, required: true, help: 'New page title' },
    { name: 'content', required: false, help: 'Optional first paragraph' },
  ],
  columns: ['id', 'title', 'url', 'parentID', 'source'],
  func: async (page, kwargs) => {
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new ArgumentError('Page title is required');
    const content = String(kwargs.content ?? '');
    await prepareInternalSession(page);
    const parent = await internalPage(page, kwargs.parent);
    const transaction = buildCreatePageTransaction({
      parentId: parent.id,
      spaceId: parent.spaceId,
      afterId: parent.content.at(-1) || '',
      title,
      content,
    });
    await sendInternalTransaction(page, parent.spaceId, transaction.payload, 'page creation');
    const created = await waitForInternalPage(page, transaction.pageId, (result) => result.title === title);
    return [{
      id: transaction.pageId,
      title: created.title,
      url: pageUrl(transaction.pageId),
      parentID: parent.id,
      source: 'internal_api',
    }];
  },
});

cli({
  site: 'notion',
  name: 'page-move',
  access: 'write',
  description: 'Move a page under another page through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'parent', positional: true, required: true, help: 'Destination parent page URL or ID' },
  ],
  columns: ['id', 'title', 'url', 'parentID', 'source'],
  func: async (page, kwargs) => {
    await prepareInternalSession(page);
    const source = await internalPage(page, kwargs.url);
    const destination = await internalPage(page, kwargs.parent);
    if (source.spaceId !== destination.spaceId) {
      throw new ArgumentError('Moving pages across workspaces is not supported');
    }
    const fromParentId = notionId(source.root.parent_id) || source.root.parent_id || '';
    if (!fromParentId) throw new ArgumentError('The source page has no movable parent');
    if (destination.id === source.id) throw new ArgumentError('A page cannot be moved under itself');
    const payload = buildReparentBlockTransaction({
      blockId: source.id,
      fromParentId,
      toParentId: destination.id,
      afterId: destination.content.at(-1) || '',
      spaceId: source.spaceId,
      userAction: 'webcmd.notion.page-move',
    });
    await sendInternalTransaction(page, source.spaceId, payload, 'page move');
    const updated = await waitForInternalPage(
      page,
      source.id,
      (result) => (notionId(result.root.parent_id) || result.root.parent_id) === destination.id,
    );
    return [{
      id: source.id,
      title: updated.title,
      url: pageUrl(source.id),
      parentID: destination.id,
      source: 'internal_api',
    }];
  },
});

cli({
  site: 'notion',
  name: 'page-duplicate',
  access: 'write',
  description: 'Duplicate a complete page subtree through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'parent', required: false, help: 'Destination parent page URL or ID; defaults to the current parent' },
    { name: 'title', required: false, help: 'Duplicate page title' },
    { name: 'without-data', type: 'boolean', default: false, help: 'Duplicate database schemas without their rows' },
  ],
  columns: ['id', 'title', 'url', 'parentID', 'recordCount', 'source'],
  func: async (page, kwargs) => {
    await prepareInternalSession(page);
    const source = await internalPage(page, kwargs.url);
    const currentParentId = notionId(source.root.parent_id) || source.root.parent_id || '';
    const destination = await internalPage(page, kwargs.parent || currentParentId);
    if (source.spaceId !== destination.spaceId) {
      throw new ArgumentError('Duplicating pages across workspaces is not supported');
    }
    const title = String(kwargs.title ?? '').trim();
    const user = await loadCurrentNotionUser(page);
    const task = buildDuplicateSubtreeTask({
      pageId: source.id,
      spaceId: source.spaceId,
      parentId: destination.id,
      siblingId: destination.id === currentParentId ? source.id : destination.content.at(-1) || '',
      userId: user.id,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      includeCollectionData: kwargs['without-data'] !== true,
    });
    let duplicateResult;
    try {
      const taskId = await enqueueNotionTask(page, { spaceId: source.spaceId, task });
      duplicateResult = duplicatedPageFromTask(await waitForNotionTask(page, taskId));
    } catch (error) {
      throw new CommandExecutionError(
        `Notion page duplication failed: ${error instanceof Error ? error.message : error}`,
        INTERNAL_API_CHANGE_HINT,
      );
    }
    let created = await waitForInternalPage(page, duplicateResult.pageId, () => true, 30);
    if (title && created.title !== title) {
      const payload = buildUpdateBlockTransaction({ blockId: created.id, spaceId: source.spaceId, text: title });
      await sendInternalTransaction(page, source.spaceId, payload, 'duplicated page rename');
      created = await waitForInternalPage(page, created.id, (result) => result.title === title);
    }
    return [{
      id: created.id,
      title: created.title,
      url: pageUrl(created.id),
      parentID: destination.id,
      recordCount: duplicateResult.recordCount,
      source: 'internal_api',
    }];
  },
});

cli({
  site: 'notion',
  name: 'page-archive',
  access: 'write',
  description: 'Move a page to Notion Trash through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [URL_ARG, { name: 'yes', type: 'boolean', default: false, help: 'Confirm archive' }],
  columns: ['id', 'title', 'archived', 'parentID', 'movedToTrashTime', 'source'],
  func: async (page, kwargs) => {
    requireConfirmation(kwargs.yes, 'page-archive');
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const parentId = notionId(target.root.parent_id) || target.root.parent_id || '';
    if (!parentId) throw new ArgumentError('The page has no archivable parent');
    const payload = buildPageArchiveTransaction({
      pageId: target.id,
      parentId,
      spaceId: target.spaceId,
      userId: (await loadCurrentNotionUser(page)).id,
    });
    await sendInternalTransaction(page, target.spaceId, payload, 'page archive');
    try {
      await deleteContentRecords(page, { pageId: target.id, spaceId: target.spaceId });
    } catch (error) {
      throw new CommandExecutionError(
        `Notion trash request failed: ${error instanceof Error ? error.message : error}`,
        INTERNAL_API_CHANGE_HINT,
      );
    }
    const archived = await waitForInternalPage(
      page,
      target.id,
      (result) => result.root.alive === false && Number.isFinite(result.root.moved_to_trash_time),
    );
    return [{
      id: target.id,
      title: target.title,
      archived: archived.root.alive === false,
      parentID: parentId,
      movedToTrashTime: archived.root.moved_to_trash_time,
      source: 'internal_api',
    }];
  },
});

cli({
  site: 'notion',
  name: 'page-restore',
  access: 'write',
  description: 'Restore a page from Notion Trash',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'parent', required: false, help: 'Any active page in the workspace, used only if the archived page cannot be loaded' },
  ],
  columns: ['id', 'title', 'url', 'restored', 'parentID', 'source'],
  func: async (page, kwargs) => {
    await prepareInternalSession(page);
    const pageId = requirePageId(kwargs.url);
    let archived;
    try {
      archived = await internalPage(page, pageId);
    } catch (error) {
      if (!kwargs.parent) throw new ArgumentError('The archived page could not be loaded. Pass --parent with an active page in the same workspace.');
      archived = await internalPage(page, kwargs.parent);
    }
    const parentId = kwargs.parent
      ? requirePageId(kwargs.parent)
      : notionId(archived.root?.parent_id) || archived.root?.parent_id || '';
    if (!parentId) throw new ArgumentError('The archived page parent could not be determined. Pass --parent with an active page.');
    const parent = await internalPage(page, parentId);
    try {
      await restorePageRecord(page, { pageId, spaceId: archived.spaceId });
    } catch (error) {
      const details = `${error instanceof Error ? error.message : error} ${error?.hint || error?.help || ''}`;
      if (!details.includes('not deleted from trash')) throw error;
      const payload = buildPageRestoreTransaction({
        pageId,
        parentId,
        afterId: parent.content.at(-1) || '',
        spaceId: archived.spaceId,
      });
      await sendInternalTransaction(page, archived.spaceId, payload, 'page restore');
    }
    const restored = await waitForInternalPage(page, pageId, (result) => result.root.alive !== false);
    return [{
      id: pageId,
      title: restored.title,
      url: pageUrl(pageId),
      restored: true,
      parentID: notionId(restored.root.parent_id) || restored.root.parent_id || '',
      source: 'internal_api',
    }];
  },
});

cli({
  site: 'notion',
  name: 'block-add',
  access: 'write',
  description: 'Append a block through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'text', positional: true, required: true, help: 'Block text' },
    { name: 'type', default: 'paragraph', help: 'paragraph, heading1, heading2, heading3, bulleted, numbered, todo, quote, callout, code, or divider' },
  ],
  columns: ['index', 'id', 'type', 'text', 'depth', 'parentID'],
  func: async (page, kwargs) => {
    const text = String(kwargs.text ?? '');
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    let transaction;
    try {
      transaction = buildAppendBlockTransaction({
        pageId: target.id,
        spaceId: target.spaceId,
        afterId: target.content.at(-1) || '',
        text,
        type: kwargs.type,
      });
    } catch (error) {
      throw new ArgumentError(error instanceof Error ? error.message : String(error));
    }
    await sendInternalTransaction(page, target.spaceId, transaction.payload, 'block append');
    const updated = await waitForInternalPage(
      page,
      target.id,
      (result) => result.blocks.some((block) => block.id === transaction.blockId && block.text === text),
    );
    return [updated.blocks.find((block) => block.id === transaction.blockId)];
  },
});

cli({
  site: 'notion',
  name: 'block-update',
  access: 'write',
  description: 'Replace a block title through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'block', positional: true, required: true, help: 'Block ID or zero-based index from notion blocks' },
    { name: 'text', positional: true, required: true, help: 'Replacement text' },
  ],
  columns: ['index', 'id', 'type', 'text', 'depth', 'parentID'],
  func: async (page, kwargs) => {
    const text = String(kwargs.text ?? '');
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const block = resolveBlock(target, kwargs.block);
    const payload = buildUpdateBlockTransaction({ blockId: block.id, spaceId: target.spaceId, text });
    await sendInternalTransaction(page, target.spaceId, payload, 'block update');
    const updated = await waitForInternalPage(
      page,
      target.id,
      (result) => result.blocks.some((candidate) => candidate.id === block.id && candidate.text === text),
    );
    return [updated.blocks.find((candidate) => candidate.id === block.id)];
  },
});

cli({
  site: 'notion',
  name: 'block-move',
  access: 'write',
  description: 'Move a top-level block after another block through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'block', positional: true, required: true, help: 'Block ID or zero-based block index to move' },
    { name: 'after', required: true, help: 'Anchor block ID or zero-based block index' },
  ],
  columns: ['index', 'id', 'type', 'text', 'depth', 'parentID'],
  func: async (page, kwargs) => {
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const block = resolveBlock(target, kwargs.block);
    const anchor = resolveBlock(target, kwargs.after);
    if (block.parentID !== target.id || anchor.parentID !== target.id) {
      throw new ArgumentError('block-move currently supports top-level blocks on the same page');
    }
    let payload;
    try {
      payload = buildMoveBlockTransaction({
        parentId: target.id,
        blockId: block.id,
        afterId: anchor.id,
        spaceId: target.spaceId,
      });
    } catch (error) {
      throw new ArgumentError(error instanceof Error ? error.message : String(error));
    }
    await sendInternalTransaction(page, target.spaceId, payload, 'block move');
    const updated = await waitForInternalPage(page, target.id, (result) => {
      const blockIndex = result.content.indexOf(block.id);
      const anchorIndex = result.content.indexOf(anchor.id);
      return blockIndex === anchorIndex + 1;
    });
    return [updated.blocks.find((candidate) => candidate.id === block.id)];
  },
});

cli({
  site: 'notion',
  name: 'block-delete',
  access: 'write',
  description: 'Delete a block and its descendants through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'block', positional: true, required: true, help: 'Block ID or zero-based block index' },
    { name: 'yes', type: 'boolean', default: false, help: 'Confirm deletion' },
  ],
  columns: ['id', 'deleted', 'pageID', 'source'],
  func: async (page, kwargs) => {
    requireConfirmation(kwargs.yes, 'block-delete');
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const block = resolveBlock(target, kwargs.block);
    const payload = buildDeleteBlockTransaction({ pageData: target, blockId: block.id });
    await sendInternalTransaction(page, target.spaceId, payload, 'block deletion');
    await waitForInternalPage(page, target.id, (result) => !result.blocks.some((candidate) => candidate.id === block.id));
    return [{ id: block.id, deleted: true, pageID: target.id, source: 'internal_api' }];
  },
});

cli({
  site: 'notion',
  name: 'block-duplicate',
  access: 'write',
  description: 'Duplicate a block and its descendants through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [URL_ARG, { name: 'block', positional: true, required: true, help: 'Block ID or zero-based block index' }],
  columns: ['index', 'id', 'type', 'text', 'depth', 'parentID'],
  func: async (page, kwargs) => {
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const source = resolveBlock(target, kwargs.block);
    const transaction = buildDuplicateBlockTransaction({ pageData: target, blockId: source.id });
    await sendInternalTransaction(page, target.spaceId, transaction.payload, 'block duplication');
    const updated = await waitForInternalPage(
      page,
      target.id,
      (result) => transaction.insertedIds.every((id) => result.blocks.some((candidate) => candidate.id === id)),
    );
    return [updated.blocks.find((candidate) => candidate.id === transaction.blockId)];
  },
});

cli({
  site: 'notion',
  name: 'block-indent',
  access: 'write',
  description: 'Nest a block under its previous sibling through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [URL_ARG, { name: 'block', positional: true, required: true, help: 'Block ID or zero-based block index' }],
  columns: ['index', 'id', 'type', 'text', 'depth', 'parentID'],
  func: async (page, kwargs) => {
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const block = resolveBlock(target, kwargs.block);
    const siblings = target.records?.[block.parentID]?.content || [];
    const position = siblings.indexOf(block.id);
    if (position <= 0) throw new ArgumentError('The first sibling cannot be indented');
    const parentId = notionId(siblings[position - 1]) || siblings[position - 1];
    const afterId = target.records?.[parentId]?.content?.at(-1) || '';
    const payload = buildReparentBlockTransaction({
      blockId: block.id,
      fromParentId: block.parentID,
      toParentId: parentId,
      afterId,
      spaceId: target.spaceId,
      userAction: 'webcmd.notion.block-indent',
    });
    await sendInternalTransaction(page, target.spaceId, payload, 'block indent');
    const updated = await waitForInternalPage(
      page,
      target.id,
      (result) => result.blocks.some((candidate) => candidate.id === block.id && candidate.parentID === parentId),
    );
    return [updated.blocks.find((candidate) => candidate.id === block.id)];
  },
});

cli({
  site: 'notion',
  name: 'block-outdent',
  access: 'write',
  description: 'Move a nested block after its parent through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [URL_ARG, { name: 'block', positional: true, required: true, help: 'Block ID or zero-based block index' }],
  columns: ['index', 'id', 'type', 'text', 'depth', 'parentID'],
  func: async (page, kwargs) => {
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const block = resolveBlock(target, kwargs.block);
    if (block.parentID === target.id) throw new ArgumentError('The block is already top-level');
    const parent = target.records?.[block.parentID];
    const grandparentId = notionId(parent?.parent_id) || parent?.parent_id || '';
    if (!grandparentId) throw new ArgumentError('The parent block has no movable parent');
    const payload = buildReparentBlockTransaction({
      blockId: block.id,
      fromParentId: block.parentID,
      toParentId: grandparentId,
      afterId: block.parentID,
      spaceId: target.spaceId,
      userAction: 'webcmd.notion.block-outdent',
    });
    await sendInternalTransaction(page, target.spaceId, payload, 'block outdent');
    const updated = await waitForInternalPage(
      page,
      target.id,
      (result) => result.blocks.some((candidate) => candidate.id === block.id && candidate.parentID === grandparentId),
    );
    return [updated.blocks.find((candidate) => candidate.id === block.id)];
  },
});

cli({
  site: 'notion',
  name: 'rename',
  access: 'write',
  description: 'Rename a page through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'title', positional: true, required: true, help: 'Replacement page title' },
  ],
  columns: ['id', 'title', 'url', 'source'],
  func: async (page, kwargs) => {
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new ArgumentError('Page title is required');
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const payload = buildUpdateBlockTransaction({ blockId: target.id, spaceId: target.spaceId, text: title });
    await sendInternalTransaction(page, target.spaceId, payload, 'page rename');
    const updated = await waitForInternalPage(page, target.id, (result) => result.title === title);
    return [{
      id: target.id,
      title: updated.title,
      url: notionUrlFrom(kwargs.url, true).href,
      source: 'internal_api',
    }];
  },
});

cli({
  site: 'notion',
  name: 'markdown-set',
  access: 'write',
  description: 'Replace page content from a Markdown file through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'file', positional: true, required: true, help: 'Local Markdown file path' },
  ],
  columns: ['id', 'title', 'url', 'blockCount', 'types', 'source'],
  func: async (page, kwargs) => {
    const file = path.resolve(String(kwargs.file ?? ''));
    let markdown;
    try {
      markdown = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new ArgumentError(`Markdown file could not be read: ${error instanceof Error ? error.message : error}`);
    }
    const blocks = markdownToNotionBlocks(markdown);
    if (!blocks.length) throw new ArgumentError('Markdown file produced no Notion blocks');

    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const transaction = buildReplaceBlocksTransaction({
      pageId: target.id,
      spaceId: target.spaceId,
      existingBlocks: target.blocks,
      blocks,
    });
    await sendInternalTransaction(page, target.spaceId, transaction.payload, 'Markdown page replacement');
    const updated = await waitForInternalPage(
      page,
      target.id,
      (result) => transaction.insertedIds.every((id) => result.blocks.some((block) => block.id === id)),
    );
    return [{
      id: target.id,
      title: updated.title,
      url: notionUrlFrom(kwargs.url, true).href,
      blockCount: transaction.insertedIds.length,
      types: summarizeNotionBlocks(blocks),
      source: 'internal_api',
    }];
  },
});

cli({
  site: 'notion',
  name: 'markdown-append',
  access: 'write',
  description: 'Append Markdown blocks to a page through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'file', positional: true, required: true, help: 'Local Markdown file path' },
  ],
  columns: ['id', 'title', 'url', 'blockCount', 'types', 'source'],
  func: async (page, kwargs) => {
    const file = path.resolve(String(kwargs.file ?? ''));
    let markdown;
    try {
      markdown = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new ArgumentError(`Markdown file could not be read: ${error instanceof Error ? error.message : error}`);
    }
    const blocks = markdownToNotionBlocks(markdown);
    if (!blocks.length) throw new ArgumentError('Markdown file produced no Notion blocks');
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const transaction = buildAppendStructuredBlocksTransaction({
      pageId: target.id,
      spaceId: target.spaceId,
      afterId: target.content.at(-1) || '',
      blocks,
      userAction: 'webcmd.notion.markdown-append',
    });
    await sendInternalTransaction(page, target.spaceId, transaction.payload, 'Markdown append');
    await waitForInternalPage(
      page,
      target.id,
      (result) => transaction.insertedIds.every((id) => result.blocks.some((block) => block.id === id)),
    );
    return [{
      id: target.id,
      title: target.title,
      url: notionUrlFrom(kwargs.url, true).href,
      blockCount: transaction.insertedIds.length,
      types: summarizeNotionBlocks(blocks),
      source: 'internal_api',
    }];
  },
});

cli({
  site: 'notion',
  name: 'page-diff',
  access: 'read',
  description: 'Compare a Notion page with a local Markdown file',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'file', positional: true, required: true, help: 'Local Markdown file path' },
  ],
  columns: ['equal', 'actualCount', 'expectedCount', 'added', 'removed', 'changed', 'changes'],
  func: async (page, kwargs) => {
    const file = path.resolve(String(kwargs.file ?? ''));
    let markdown;
    try {
      markdown = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new ArgumentError(`Markdown file could not be read: ${error instanceof Error ? error.message : error}`);
    }
    const expected = markdownToNotionBlocks(markdown);
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    return [diffNotionBlocks(target.blocks, expected)];
  },
});

cli({
  site: 'notion',
  name: 'image-add',
  access: 'write',
  description: 'Upload a local image and append it to a page through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'file', positional: true, required: true, help: 'Local image file path' },
    { name: 'caption', required: false, help: 'Optional image caption' },
  ],
  columns: ['index', 'id', 'type', 'fileName', 'size', 'width', 'height', 'caption', 'parentID', 'source'],
  func: async (page, kwargs) => {
    const image = readImageFile(kwargs.file);
    const caption = String(kwargs.caption ?? '').trim();
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const placeholder = buildAppendImagePlaceholderTransaction({
      pageId: target.id,
      spaceId: target.spaceId,
      afterId: target.content.at(-1) || '',
      fileName: image.fileName,
      sizeText: image.sizeText,
      width: image.width,
      height: image.height,
    });
    await sendInternalTransaction(page, target.spaceId, placeholder.payload, 'image placeholder creation');

    try {
      await waitForInternalPage(
        page,
        target.id,
        (result) => result.blocks.some((block) => block.id === placeholder.blockId && block.type === 'image'),
      );
      const upload = await getUploadSpaceFileUrl(page, {
        spaceId: target.spaceId,
        blockId: placeholder.blockId,
        fileName: image.fileName,
        contentType: image.contentType,
        contentLength: image.bytes.length,
      });
      await uploadSignedFile(upload, image.bytes, image.contentType);
      const payload = buildFinalizeImageTransaction({
        pageId: target.id,
        blockId: placeholder.blockId,
        spaceId: target.spaceId,
        source: upload.url,
        fileName: image.fileName,
        sizeText: image.sizeText,
        caption,
        width: image.width,
        height: image.height,
      });
      await sendInternalTransaction(page, target.spaceId, payload, 'image finalization');
      const updated = await waitForInternalPage(
        page,
        target.id,
        (result) => result.blocks.some((block) => block.id === placeholder.blockId && block.source === upload.url),
      );
      return [updated.blocks.find((block) => block.id === placeholder.blockId)];
    } catch (error) {
      const rollback = buildRemoveBlockTransaction({
        pageId: target.id,
        blockId: placeholder.blockId,
        spaceId: target.spaceId,
      });
      await saveTransaction(page, target.spaceId, rollback).catch(() => {});
      throw new CommandExecutionError(
        `Notion image upload failed: ${error instanceof Error ? error.message : error}`,
        INTERNAL_API_CHANGE_HINT,
      );
    }
  },
});

cli({
  site: 'notion',
  name: 'image-replace',
  access: 'write',
  description: 'Replace the binary content of an existing image block',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'block', positional: true, required: true, help: 'Image block ID or zero-based block index' },
    { name: 'file', positional: true, required: true, help: 'Replacement local image file path' },
    { name: 'caption', required: false, help: 'Replacement caption; defaults to the existing caption' },
  ],
  columns: ['index', 'id', 'type', 'fileName', 'size', 'width', 'height', 'caption', 'parentID', 'source'],
  func: async (page, kwargs) => {
    const image = readImageFile(kwargs.file);
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const block = resolveBlock(target, kwargs.block);
    if (block.type !== 'image') throw new ArgumentError(`Block is not an image: ${block.id}`);
    const caption = kwargs.caption == null ? String(block.caption ?? '') : String(kwargs.caption).trim();
    try {
      const upload = await getUploadSpaceFileUrl(page, {
        spaceId: target.spaceId,
        blockId: block.id,
        fileName: image.fileName,
        contentType: image.contentType,
        contentLength: image.bytes.length,
      });
      await uploadSignedFile(upload, image.bytes, image.contentType);
      const payload = buildFinalizeImageTransaction({
        pageId: target.id,
        blockId: block.id,
        spaceId: target.spaceId,
        source: upload.url,
        fileName: image.fileName,
        sizeText: image.sizeText,
        caption,
        width: image.width,
        height: image.height,
        updateFileIds: false,
      });
      await sendInternalTransaction(page, target.spaceId, payload, 'image replacement');
      const updated = await waitForInternalPage(
        page,
        target.id,
        (result) => result.blocks.some((candidate) => candidate.id === block.id && candidate.source === upload.url),
      );
      return [updated.blocks.find((candidate) => candidate.id === block.id)];
    } catch (error) {
      throw new CommandExecutionError(
        `Notion image replacement failed: ${error instanceof Error ? error.message : error}`,
        INTERNAL_API_CHANGE_HINT,
      );
    }
  },
});

cli({
  site: 'notion',
  name: 'file-add',
  access: 'write',
  description: 'Upload a local file and append it to a page',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'file', positional: true, required: true, help: 'Local file path' },
    { name: 'caption', required: false, help: 'Optional file caption' },
  ],
  columns: ['index', 'id', 'type', 'fileName', 'size', 'caption', 'parentID', 'source'],
  func: async (page, kwargs) => {
    const file = readLocalFile(kwargs.file);
    const caption = String(kwargs.caption ?? '').trim();
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const placeholder = buildAppendFilePlaceholderTransaction({
      pageId: target.id,
      spaceId: target.spaceId,
      afterId: target.content.at(-1) || '',
      fileName: file.fileName,
      sizeText: file.sizeText,
    });
    await sendInternalTransaction(page, target.spaceId, placeholder.payload, 'file placeholder creation');
    try {
      await waitForInternalPage(
        page,
        target.id,
        (result) => result.blocks.some((block) => block.id === placeholder.blockId && block.type === 'file'),
      );
      const upload = await getUploadSpaceFileUrl(page, {
        spaceId: target.spaceId,
        blockId: placeholder.blockId,
        fileName: file.fileName,
        contentType: file.contentType,
        contentLength: file.bytes.length,
      });
      await uploadSignedFile(upload, file.bytes, file.contentType);
      const payload = buildFinalizeFileTransaction({
        pageId: target.id,
        blockId: placeholder.blockId,
        spaceId: target.spaceId,
        source: upload.url,
        fileName: file.fileName,
        sizeText: file.sizeText,
        caption,
      });
      await sendInternalTransaction(page, target.spaceId, payload, 'file finalization');
      const updated = await waitForInternalPage(
        page,
        target.id,
        (result) => result.blocks.some((block) => block.id === placeholder.blockId && block.source === upload.url),
      );
      return [updated.blocks.find((block) => block.id === placeholder.blockId)];
    } catch (error) {
      const rollback = buildRemoveBlockTransaction({
        pageId: target.id,
        blockId: placeholder.blockId,
        spaceId: target.spaceId,
      });
      await saveTransaction(page, target.spaceId, rollback).catch(() => {});
      throw new CommandExecutionError(
        `Notion file upload failed: ${error instanceof Error ? error.message : error}`,
        INTERNAL_API_CHANGE_HINT,
      );
    }
  },
});

cli({
  site: 'notion',
  name: 'file-download',
  access: 'read',
  description: 'Download an image or file block through the signed-in browser session',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'block', positional: true, required: true, help: 'Image or file block ID or zero-based block index' },
    { name: 'output', required: false, help: 'Output path; defaults to the block file name in the current directory' },
    { name: 'force', type: 'boolean', default: false, help: 'Overwrite an existing output file' },
  ],
  columns: ['id', 'fileName', 'path', 'bytes', 'source'],
  func: async (page, kwargs) => {
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const block = resolveBlock(target, kwargs.block);
    if (!block.source) throw new ArgumentError(`Block has no downloadable source: ${block.id}`);
    const fileName = block.fileName || `notion-${block.id}`;
    const signedUrl = await getSignedFileUrl(page, {
      source: block.source,
      blockId: block.id,
      spaceId: target.spaceId,
    });
    const bytes = await downloadSignedFileViaPage(page, signedUrl);
    const output = writeOutputFile(kwargs.output, bytes, { force: kwargs.force, defaultName: fileName });
    return [{ id: block.id, fileName, path: output, bytes: bytes.length, source: 'internal_api' }];
  },
});

cli({
  site: 'notion',
  name: 'page-export',
  access: 'read',
  description: 'Export a Notion page as Markdown, HTML, or PDF',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'export-type', default: 'markdown', help: 'markdown, html, or pdf' },
    { name: 'output', required: false, help: 'Output path; defaults to a generated file name' },
    { name: 'recursive', type: 'boolean', default: false, help: 'Include child pages' },
    { name: 'comments', type: 'boolean', default: false, help: 'Include comments in the export' },
    { name: 'force', type: 'boolean', default: false, help: 'Overwrite an existing output file' },
  ],
  columns: ['pageID', 'format', 'path', 'bytes', 'recursive', 'comments', 'source'],
  func: async (page, kwargs) => {
    const format = String(kwargs['export-type'] ?? 'markdown').toLowerCase();
    if (!['markdown', 'html', 'pdf'].includes(format)) {
      throw new ArgumentError('format must be markdown, html, or pdf');
    }
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const task = buildExportTask({
      pageId: target.id,
      spaceId: target.spaceId,
      format,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      recursive: kwargs.recursive === true,
      shouldExportComments: kwargs.comments === true,
    });
    let result;
    try {
      const taskId = await enqueueNotionTask(page, { spaceId: target.spaceId, task });
      result = await waitForNotionTask(page, taskId);
    } catch (error) {
      throw new CommandExecutionError(
        `Notion page export failed: ${error instanceof Error ? error.message : error}`,
        INTERNAL_API_CHANGE_HINT,
      );
    }
    const exportUrl = exportUrlFromTask(result);
    const bytes = await downloadSignedFileViaPage(page, exportUrl);
    const extension = format === 'pdf' ? 'pdf' : 'zip';
    const output = writeOutputFile(kwargs.output, bytes, {
      force: kwargs.force,
      defaultName: `notion-export-${target.id.replaceAll('-', '')}.${extension}`,
    });
    return [{
      pageID: target.id,
      format,
      path: output,
      bytes: bytes.length,
      recursive: kwargs.recursive === true,
      comments: kwargs.comments === true,
      source: 'internal_api',
    }];
  },
});

cli({
  site: 'notion',
  name: 'batch',
  access: 'write',
  description: 'Run a validated sequence of Notion operations from a JSON file',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    { name: 'file', positional: true, required: true, help: 'Batch JSON file path' },
    { name: 'url', required: false, help: 'Override the page URL declared in the batch file' },
    { name: 'dry-run', type: 'boolean', default: false, help: 'Validate without executing operations' },
    { name: 'allow-destructive', type: 'boolean', default: false, help: 'Allow destructive operations such as block-delete' },
  ],
  columns: ['dryRun', 'atomic', 'url', 'operationCount', 'completed', 'results'],
  func: async (page, kwargs) => {
    const file = path.resolve(String(kwargs.file ?? ''));
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new ArgumentError(`Batch file could not be read: ${error instanceof Error ? error.message : error}`);
    }
    let batch;
    try {
      batch = parseBatchDocument(text, {
        baseDir: path.dirname(file),
        overrideUrl: String(kwargs.url ?? ''),
      });
      notionUrlFrom(batch.url, true);
    } catch (error) {
      throw new ArgumentError(error instanceof Error ? error.message : String(error));
    }
    const destructive = batch.operations.filter((operation) => operation.destructive);
    if (destructive.length && kwargs['allow-destructive'] !== true) {
      throw new ArgumentError(`Batch contains destructive operations: ${destructive.map((operation) => operation.id).join(', ')}. Use --allow-destructive.`);
    }
    if (kwargs['dry-run'] === true) {
      return [{
        dryRun: true,
        atomic: false,
        url: batch.url,
        operationCount: batch.operations.length,
        completed: [],
        results: batch.operations.map(({ id, command }) => ({ id, command, valid: true })),
      }];
    }

    await prepareInternalSession(page);
    const completed = [];
    const results = [];
    for (const operation of batch.operations) {
      try {
        const result = await runBatchOperation(page, batch.url, operation, kwargs['allow-destructive'] === true);
        completed.push(operation.id);
        results.push({ id: operation.id, command: operation.command, ok: true, result });
      } catch (error) {
        throw new CommandExecutionError(
          `Batch step ${operation.id} failed after ${completed.length} completed operation(s): ${error instanceof Error ? error.message : error}`,
          `Batch execution is sequential and non-atomic. Completed steps were not rolled back: ${completed.join(', ') || 'none'}`,
        );
      }
    }
    return [{
      dryRun: false,
      atomic: false,
      url: batch.url,
      operationCount: batch.operations.length,
      completed,
      results,
    }];
  },
});

cli({
  site: 'notion',
  name: 'database-schema',
  access: 'read',
  description: 'List a Notion database property schema',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [URL_ARG],
  columns: ['index', 'id', 'name', 'type', 'options'],
  func: async (page, kwargs) => {
    await prepareInternalSession(page);
    const { database } = await databaseContext(page, kwargs.url);
    return databaseSchemaRows(database);
  },
});

cli({
  site: 'notion',
  name: 'database-query',
  access: 'read',
  description: 'Query rows from a Notion database view',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'search', required: false, help: 'Optional database search text' },
    { name: 'filter', required: false, help: 'JSON property conditions applied to decoded rows' },
    { name: 'sort', required: false, help: 'JSON sort rule or rule array with property and direction' },
    LIMIT_ARG,
  ],
  columns: ['id', 'title', 'properties', 'createdTime', 'lastEditedTime'],
  func: async (page, kwargs) => {
    const limit = limitFrom(kwargs.limit);
    const filter = parseJsonValue(kwargs.filter, 'filter');
    const sort = parseJsonValue(kwargs.sort, 'sort');
    if (filter !== null && (!filter || typeof filter !== 'object' || Array.isArray(filter))) {
      throw new ArgumentError('filter must be a JSON object');
    }
    if (sort !== null && (!sort || typeof sort !== 'object')) {
      throw new ArgumentError('sort must be a JSON object or array');
    }
    await prepareInternalSession(page);
    const { target, database, timeZone } = await databaseContext(page, kwargs.url);
    const result = await queryDatabase(page, {
      database,
      spaceId: target.spaceId,
      limit: filter || sort ? MAX_LIMIT : limit,
      search: String(kwargs.search ?? ''),
      timeZone,
    });
    let rows = result.rows;
    try {
      if (filter) rows = filterDatabaseRows(rows, filter, database.collection.schema);
      if (sort) rows = sortDatabaseRows(rows, sort, database.collection.schema);
    } catch (error) {
      throw new ArgumentError(error instanceof Error ? error.message : String(error));
    }
    rows = rows.slice(0, limit).map((row, index) => ({ ...row, index }));
    if (!rows.length) throw new EmptyResultError('notion database-query', 'Notion reported a recognized empty database result.');
    return rows;
  },
});

cli({
  site: 'notion',
  name: 'database-row-create',
  access: 'write',
  description: 'Create a row in a Notion database',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'title', positional: true, required: true, help: 'Row title' },
    { name: 'properties', required: false, help: 'Additional properties as a JSON object keyed by property name or ID' },
  ],
  columns: ['id', 'title', 'properties', 'createdTime', 'lastEditedTime'],
  func: async (page, kwargs) => {
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new ArgumentError('Row title is required');
    const input = parseJsonObject(kwargs.properties, 'properties');
    await prepareInternalSession(page);
    const { target, database, timeZone } = await databaseContext(page, kwargs.url);
    const titleProperty = databaseSchemaRows(database).find((property) => property.type === 'title');
    if (!titleProperty) throw new CommandExecutionError('Notion database has no title property');
    const currentUser = await loadCurrentNotionUser(page);
    const properties = encodeDatabaseProperties(database.collection.schema, {
      ...input,
      [titleProperty.id]: title,
    }, { currentUserId: currentUser.id });
    const transaction = buildDatabaseRowCreateTransaction({
      database,
      spaceId: target.spaceId,
      properties,
    });
    await sendInternalTransaction(page, target.spaceId, transaction.payload, 'database row creation');
    const updated = await waitForDatabase(page, {
      database,
      spaceId: target.spaceId,
      limit: 100,
      search: title,
      timeZone,
    }, (result) => result.rows.some((row) => row.id === transaction.rowId));
    return [updated.rows.find((row) => row.id === transaction.rowId)];
  },
});

cli({
  site: 'notion',
  name: 'database-row-update',
  access: 'write',
  description: 'Update properties on a Notion database row',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'row', positional: true, required: true, help: 'Row ID or zero-based query index' },
    { name: 'properties', required: true, help: 'Replacement properties as a JSON object keyed by property name or ID' },
  ],
  columns: ['id', 'title', 'properties', 'createdTime', 'lastEditedTime'],
  func: async (page, kwargs) => {
    const input = parseJsonObject(kwargs.properties, 'properties');
    if (!Object.keys(input).length) throw new ArgumentError('properties must contain at least one property');
    await prepareInternalSession(page);
    const { target, database, timeZone } = await databaseContext(page, kwargs.url);
    const before = await queryDatabase(page, { database, spaceId: target.spaceId, limit: 200, timeZone });
    const row = resolveDatabaseRow(before.rows, kwargs.row);
    const currentUser = await loadCurrentNotionUser(page);
    const properties = encodeDatabaseProperties(database.collection.schema, input, { currentUserId: currentUser.id });
    const payload = buildDatabaseRowUpdateTransaction({ rowId: row.id, spaceId: target.spaceId, properties });
    await sendInternalTransaction(page, target.spaceId, payload, 'database row update');
    const updated = await waitForDatabase(
      page,
      { database, spaceId: target.spaceId, limit: 200, timeZone },
      (result) => {
        const candidate = result.rows.find((item) => item.id === row.id);
        return candidate && Object.entries(properties).every(([propertyId, value]) => {
          const property = database.collection.schema[propertyId];
          const name = property?.name || propertyId;
          const expected = decodeDatabasePropertyValue(value, property);
          return String(candidate.properties[name] ?? '') === expected;
        });
      },
    );
    return [updated.rows.find((candidate) => candidate.id === row.id)];
  },
});

cli({
  site: 'notion',
  name: 'button-check',
  access: 'read',
  description: 'Check one visible Notion button by exact label without clicking it',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'label', positional: true, required: true, help: 'Exact visible text or aria label' },
  ],
  columns: ['label', 'exactMatches', 'enabled'],
  func: async (page, kwargs) => {
    const label = String(kwargs.label ?? '').trim();
    if (!label) throw new ArgumentError('Button label is required');
    await navigateNotion(page, kwargs.url);
    await requireLogin(page);
    await page.sleep(0.8);
    const result = unwrapEvaluateResult(await page.evaluate(buildButtonProbeScript(label)));
    const error = buttonProbeError(result);
    if (error) throw new ArgumentError(error);
    return [result];
  },
});

cli({
  site: 'notion',
  name: 'button-click',
  access: 'write',
  description: 'Click one visible Notion button matched by exact label',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'label', positional: true, required: true, help: 'Exact visible text or aria label' },
    { name: 'yes', type: 'boolean', default: false, help: 'Confirm the button side effect' },
  ],
  columns: ['label', 'clicked', 'url', 'notifications'],
  func: async (page, kwargs) => {
    requireConfirmation(kwargs.yes, 'button-click');
    const label = String(kwargs.label ?? '').trim();
    if (!label) throw new ArgumentError('Button label is required');
    await navigateNotion(page, kwargs.url);
    await requireLogin(page);
    await page.sleep(0.8);
    const result = unwrapEvaluateResult(await page.evaluate(buildButtonProbeScript(label, { mark: true })));
    const error = buttonProbeError(result);
    if (error) throw new ArgumentError(error);
    await page.click('[data-webcmd-notion-button-target="true"]');
    await page.sleep(1.2);
    const notifications = unwrapEvaluateResult(await page.evaluate(`(() => Array.from(
      document.querySelectorAll('[role="alert"], [role="status"]')
    ).map((node) => String(node.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 10))()`));
    return [{ label, clicked: true, url: notionUrlFrom(kwargs.url, true).href, notifications }];
  },
});

cli({
  site: 'notion',
  name: 'database-row-delete',
  access: 'write',
  description: 'Delete a Notion database row',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'row', positional: true, required: true, help: 'Row ID or zero-based query index' },
    { name: 'yes', type: 'boolean', default: false, help: 'Confirm deletion' },
  ],
  columns: ['id', 'title', 'deleted', 'source'],
  func: async (page, kwargs) => {
    requireConfirmation(kwargs.yes, 'database-row-delete');
    await prepareInternalSession(page);
    const { target, database, timeZone } = await databaseContext(page, kwargs.url);
    const before = await queryDatabase(page, { database, spaceId: target.spaceId, limit: 200, timeZone });
    const row = resolveDatabaseRow(before.rows, kwargs.row);
    const payload = buildDatabaseRowDeleteTransaction({ rowId: row.id, spaceId: target.spaceId });
    await sendInternalTransaction(page, target.spaceId, payload, 'database row deletion');
    await waitForDatabase(
      page,
      { database, spaceId: target.spaceId, limit: 200, timeZone },
      (result) => !result.rows.some((candidate) => candidate.id === row.id),
    );
    return [{ id: row.id, title: row.title, deleted: true, source: 'internal_api' }];
  },
});

cli({
  site: 'notion',
  name: 'comment-list',
  access: 'read',
  description: 'List page comments and their discussion state',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'include-resolved', type: 'boolean', default: false, help: 'Include resolved discussions' },
  ],
  columns: ['index', 'discussionID', 'commentID', 'text', 'resolved', 'author', 'createdTime', 'lastEditedTime'],
  func: async (page, kwargs) => {
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    return commentRows(target, kwargs['include-resolved'] === true);
  },
});

cli({
  site: 'notion',
  name: 'comment-add',
  access: 'write',
  description: 'Add a page comment or reply to an existing discussion',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'text', positional: true, required: true, help: 'Comment text' },
    { name: 'discussion', required: false, help: 'Existing discussion ID to reply to' },
  ],
  columns: ['index', 'discussionID', 'commentID', 'text', 'resolved', 'author', 'createdTime', 'lastEditedTime'],
  func: async (page, kwargs) => {
    const text = String(kwargs.text ?? '').trim();
    if (!text) throw new ArgumentError('Comment text is required');
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    const requestedDiscussion = kwargs.discussion ? notionId(kwargs.discussion) : '';
    if (kwargs.discussion && !requestedDiscussion) throw new ArgumentError('discussion must be a valid Notion ID');
    if (requestedDiscussion && !target.discussions?.[requestedDiscussion]) {
      throw new ArgumentError(`Discussion not found on page: ${requestedDiscussion}`);
    }
    const user = await loadCurrentNotionUser(page);
    const transaction = buildCommentAddTransaction({
      pageId: target.id,
      spaceId: target.spaceId,
      userId: user.id,
      text,
      ...(requestedDiscussion ? { discussionId: requestedDiscussion, existingDiscussion: true } : {}),
    });
    await sendInternalTransaction(page, target.spaceId, transaction.payload, 'comment creation');
    const updated = await waitForInternalPage(
      page,
      target.id,
      (result) => Boolean(result.comments?.[transaction.commentId]),
    );
    return commentRows(updated, true).filter((row) => row.commentID === transaction.commentId);
  },
});

cli({
  site: 'notion',
  name: 'comment-resolve',
  access: 'write',
  description: 'Resolve or reopen a page comment discussion',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    URL_ARG,
    { name: 'discussion', positional: true, required: true, help: 'Discussion ID from comment-list' },
    { name: 'reopen', type: 'boolean', default: false, help: 'Reopen instead of resolve' },
  ],
  columns: ['discussionID', 'resolved', 'source'],
  func: async (page, kwargs) => {
    const discussionId = notionId(kwargs.discussion);
    if (!discussionId) throw new ArgumentError('discussion must be a valid Notion ID');
    await prepareInternalSession(page);
    const target = await internalPage(page, kwargs.url);
    if (!target.discussions?.[discussionId]) throw new ArgumentError(`Discussion not found on page: ${discussionId}`);
    const resolved = kwargs.reopen !== true;
    const payload = buildCommentResolveTransaction({ discussionId, spaceId: target.spaceId, resolved });
    await sendInternalTransaction(page, target.spaceId, payload, resolved ? 'comment resolution' : 'comment reopening');
    await waitForInternalPage(
      page,
      target.id,
      (result) => result.discussions?.[discussionId]?.resolved === resolved,
    );
    return [{ discussionID: discussionId, resolved, source: 'internal_api' }];
  },
});

registerRowsCommand({
  name: 'sidebar',
  operation: 'sidebar',
  description: 'List pages and databases visible in the Notion sidebar',
  columns: ['index', 'title', 'url', 'kind'],
});

registerRowsCommand({
  name: 'favorites',
  operation: 'favorites',
  description: 'List pages visible in the Notion Favorites section',
  columns: ['index', 'title', 'url'],
});

registerRowsCommand({
  name: 'links',
  operation: 'links',
  description: 'List links visible in a Notion page',
  columns: ['index', 'text', 'url'],
  urlRequired: true,
});

cli({
  site: 'notion',
  name: 'search',
  access: 'read',
  description: 'Search pages and databases through Notion Quick Find',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    { name: 'query', positional: true, required: true, help: 'Search query' },
    SEARCH_LIMIT_ARG,
  ],
  columns: ['index', 'title', 'url', 'kind'],
  func: async (page, kwargs) => {
    const query = String(kwargs.query ?? '').trim();
    if (!query) throw new ArgumentError('Search query is required');
    const limit = limitFrom(kwargs.limit, 50);
    await navigateNotion(page, NOTION_HOME);

    const prepared = unwrapEvaluateResult(await page.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('button, [role="button"]'));
      const trigger = nodes.find((node) => /^(search|検索)|search|検索/i.test(
        (node.getAttribute('aria-label') || node.textContent || '').trim()
      ));
      if (!trigger) return false;
      trigger.setAttribute('data-webcmd-notion-search-trigger', 'true');
      return true;
    })()`));
    if (prepared) {
      await page.click('[data-webcmd-notion-search-trigger="true"]');
    } else {
      await page.pressKey(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
    }
    await page.wait({
      selector: '[role="dialog"] input[role="combobox"], [role="dialog"] input[type="search"]',
      timeout: 10,
    });

    const inputReady = unwrapEvaluateResult(await page.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]') || document;
      const input = dialog.querySelector('input[role="combobox"], input[type="search"], input[placeholder*="Search" i], input[placeholder*="検索"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, ${JSON.stringify(query)});
      else input.value = ${JSON.stringify(query)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`));
    if (!inputReady) {
      await page.pressKey('Escape').catch(() => {});
      throw new CommandExecutionError(
        'Notion Quick Find input was not found',
        'Notion HTML may have changed. Update the plugin parser and its fixtures before retrying.',
      );
    }
    await page.sleep(1.5);
    const rows = await extract(page, 'search', limit);
    await page.pressKey('Escape').catch(() => {});
    if (!rows.length) {
      throw new EmptyResultError('notion search', `No Notion results matched "${query}".`);
    }
    return rows;
  },
});

cli({
  site: 'notion',
  name: 'workspaces',
  access: 'read',
  description: 'List Notion workspaces available to the current account',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [OPTIONAL_URL_ARG, LIMIT_ARG],
  columns: ['index', 'title', 'access', 'current'],
  func: async (page, kwargs) => {
    const limit = limitFrom(kwargs.limit);
    await navigateNotion(page, kwargs.url);
    const rows = await workspaceRows(page, limit);
    await page.pressKey('Escape').catch(() => {});
    return rows;
  },
});

cli({
  site: 'notion',
  name: 'workspace',
  access: 'write',
  description: 'Switch the current Notion workspace by name',
  domain: 'www.notion.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  defaultFormat: 'json',
  args: [
    { name: 'name', positional: true, required: true, help: 'Workspace name from notion workspaces' },
    { name: 'url', required: false, help: 'Notion page URL to open before switching' },
  ],
  columns: ['from', 'to', 'switched', 'url'],
  func: async (page, kwargs) => {
    const requested = String(kwargs.name ?? '').trim();
    if (!requested) throw new ArgumentError('Workspace name is required');
    await navigateNotion(page, kwargs.url);
    const before = await currentState(page);
    const rows = await workspaceRows(page);
    const normalized = requested.toLocaleLowerCase();
    const exact = rows.filter((row) => row.title.toLocaleLowerCase() === normalized);
    const matches = exact.length ? exact : rows.filter((row) => row.title.toLocaleLowerCase().includes(normalized));
    if (matches.length !== 1) {
      await page.pressKey('Escape').catch(() => {});
      const available = rows.map((row) => row.title).join(', ');
      throw new ArgumentError(
        matches.length === 0
          ? `Workspace not found: ${requested}. Available: ${available}`
          : `Workspace name is ambiguous: ${requested}. Matches: ${matches.map((row) => row.title).join(', ')}`,
      );
    }
    const target = matches[0];
    if (target.current) {
      await page.pressKey('Escape').catch(() => {});
      return [{ from: before.workspaceName, to: target.title, switched: false, url: before.url }];
    }

    const marked = unwrapEvaluateResult(await page.evaluate(`(() => {
      const menu = Array.from(document.querySelectorAll('[role="menu"], [role="dialog"]'))
        .find((node) => node.querySelector('[role="menuitem"]'));
      const item = menu?.querySelectorAll('[role="menuitem"]')[${Number(target.index)}];
      if (!item) return false;
      item.setAttribute('data-webcmd-notion-workspace-target', 'true');
      return true;
    })()`));
    if (!marked) {
      await page.pressKey('Escape').catch(() => {});
      throw new CommandExecutionError('Notion workspace menu changed before selection');
    }
    await page.click('[data-webcmd-notion-workspace-target="true"]');
    await page.sleep(1);

    let after = await currentState(page);
    const deadline = Date.now() + 10_000;
    while (after.workspaceName.toLocaleLowerCase() !== target.title.toLocaleLowerCase() && Date.now() < deadline) {
      await page.sleep(0.25);
      after = await currentState(page);
    }
    if (after.workspaceName.toLocaleLowerCase() !== target.title.toLocaleLowerCase()) {
      throw new TimeoutError(`Notion workspace switch to ${target.title}`, 10);
    }
    return [{ from: before.workspaceName, to: target.title, switched: true, url: after.url }];
  },
});
