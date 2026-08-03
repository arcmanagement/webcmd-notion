import { randomUUID } from 'node:crypto';
import {
  blockPointer,
  buildTransaction,
  notionId,
  richTextToPlain,
  unwrapRecord,
} from './notion-internal-api.mjs';

const API_ROOT = 'https://app.notion.com/api/v3';

function propertyName(property, id) {
  return String(property?.name || id);
}

function personId(value, currentUserId) {
  const requested = String(value ?? '').trim();
  if (requested.toLocaleLowerCase() === 'me') {
    const current = notionId(currentUserId);
    if (!current) throw new Error('Current Notion user ID was not available');
    return current;
  }
  const id = notionId(requested);
  if (!id) throw new Error('Person values must be "me" or a Notion user ID');
  return id;
}

export function findDatabase(pageData, requestedViewId = '') {
  const records = [pageData.root, ...Object.values(pageData.records || {})];
  const block = records.find((candidate) => candidate?.collection_id)
    || records.find((candidate) => candidate?.format?.collection_pointer?.id);
  const collectionId = notionId(block?.collection_id)
    || notionId(block?.format?.collection_pointer?.id)
    || block?.collection_id
    || block?.format?.collection_pointer?.id
    || Object.keys(pageData.collections || {})[0]
    || '';
  if (!collectionId) throw new Error('No database collection was found on the page');
  const collection = pageData.collections?.[collectionId];
  if (!collection) throw new Error(`Database collection record was not returned: ${collectionId}`);
  const requested = notionId(requestedViewId) || requestedViewId;
  const viewIds = block?.view_ids || Object.values(pageData.collectionViews || {})
    .filter((view) => (notionId(view.collection_id) || view.collection_id) === collectionId)
    .map((view) => view.id);
  const viewId = requested || notionId(viewIds?.[0]) || viewIds?.[0] || Object.keys(pageData.collectionViews || {})[0] || '';
  if (!viewId) throw new Error('No database view was found on the page');
  const view = pageData.collectionViews?.[viewId];
  return { collectionId, collection, viewId, view };
}

export function databaseSchemaRows(database) {
  return Object.entries(database.collection.schema || {}).map(([id, property], index) => ({
    index,
    id,
    name: propertyName(property, id),
    type: property.type || 'text',
    options: property.options || [],
  }));
}

function normalizePropertyValue(property, value, currentUserId = '') {
  if (value === null || value === undefined) return [];
  const type = property?.type || 'text';
  if (type === 'checkbox') return [[value === true || value === 'Yes' ? 'Yes' : 'No']];
  if (type === 'multi_select') {
    const values = Array.isArray(value) ? value : String(value).split(',').map((item) => item.trim()).filter(Boolean);
    return [[values.join(',')]];
  }
  if (type === 'date') {
    const start = typeof value === 'object' ? value.start : value;
    if (!start) return [];
    const dateValue = String(start);
    const dateType = dateValue.includes('T') ? 'datetime' : 'date';
    return [[dateValue, [['d', {
      type: dateType,
      start_date: dateValue.slice(0, 10),
      ...(dateType === 'datetime' ? { start_time: dateValue.slice(11, 16) } : {}),
    }]]]];
  }
  if (type === 'person') {
    const values = Array.isArray(value) ? value : [value];
    return values.map((item) => ['‣', [['u', personId(item, currentUserId)]]]);
  }
  if (['title', 'text', 'number', 'select', 'status', 'url', 'email', 'phone_number'].includes(type)) {
    return [[String(value)]];
  }
  throw new Error(`Database property type is not supported for writes: ${type}`);
}

export function encodeDatabaseProperties(schema, values, { currentUserId = '' } = {}) {
  const input = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  const entries = Object.entries(schema || {});
  const byName = new Map(entries.map(([id, property]) => [propertyName(property, id).toLocaleLowerCase(), [id, property]]));
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    const match = schema?.[key] ? [key, schema[key]] : byName.get(key.toLocaleLowerCase());
    if (!match) throw new Error(`Database property was not found: ${key}`);
    output[match[0]] = normalizePropertyValue(match[1], value, currentUserId);
  }
  return output;
}

export function decodeDatabasePropertyValue(value, property) {
  if (property?.type !== 'person') return richTextToPlain(value);
  if (!Array.isArray(value)) return '';
  return value.flatMap((segment) => {
    const annotations = Array.isArray(segment?.[1]) ? segment[1] : [];
    return annotations
      .filter((annotation) => Array.isArray(annotation) && annotation[0] === 'u')
      .map((annotation) => notionId(annotation[1]) || String(annotation[1] ?? ''));
  }).filter(Boolean).join(',');
}

export function decodeDatabaseRow(block, schema) {
  const properties = {};
  for (const [id, property] of Object.entries(schema || {})) {
    properties[propertyName(property, id)] = decodeDatabasePropertyValue(block.properties?.[id], property);
  }
  return {
    id: notionId(block.id) || block.id,
    title: Object.entries(schema || {}).find(([, property]) => property.type === 'title')
      ? richTextToPlain(block.properties?.[Object.entries(schema).find(([, property]) => property.type === 'title')[0]])
      : '',
    properties,
    createdTime: block.created_time || null,
    lastEditedTime: block.last_edited_time || null,
  };
}

function comparable(value) {
  const text = String(value ?? '');
  const number = Number(text);
  return text.trim() !== '' && Number.isFinite(number) ? number : text.toLocaleLowerCase();
}

function testCondition(actualValue, condition) {
  const actualText = String(actualValue ?? '');
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
    return comparable(actualText) === comparable(condition);
  }
  const entries = Object.entries(condition);
  if (entries.length !== 1) throw new Error('Each database filter condition must contain exactly one operator');
  const [operator, expected] = entries[0];
  const actual = comparable(actualText);
  const target = comparable(expected);
  if (operator === 'equals') return actual === target;
  if (operator === 'notEquals') return actual !== target;
  if (operator === 'contains') return actualText.toLocaleLowerCase().includes(String(expected).toLocaleLowerCase());
  if (operator === 'startsWith') return actualText.toLocaleLowerCase().startsWith(String(expected).toLocaleLowerCase());
  if (operator === 'endsWith') return actualText.toLocaleLowerCase().endsWith(String(expected).toLocaleLowerCase());
  if (operator === 'in' || operator === 'notIn') {
    if (!Array.isArray(expected)) throw new Error(`${operator} requires an array`);
    const matched = expected.some((item) => actual === comparable(item));
    return operator === 'in' ? matched : !matched;
  }
  if (operator === 'greaterThan') return actual > target;
  if (operator === 'greaterThanOrEqual') return actual >= target;
  if (operator === 'lessThan') return actual < target;
  if (operator === 'lessThanOrEqual') return actual <= target;
  if (operator === 'isEmpty') return expected === true ? actualText === '' : actualText !== '';
  throw new Error(`Database filter operator is not supported: ${operator}`);
}

function propertyValue(row, key, schema) {
  const schemaEntry = schema?.[key]
    ? [key, schema[key]]
    : Object.entries(schema || {}).find(([, property]) => propertyName(property, '').toLocaleLowerCase() === key.toLocaleLowerCase());
  if (!schemaEntry) throw new Error(`Database property was not found: ${key}`);
  return row.properties[propertyName(schemaEntry[1], schemaEntry[0])] ?? '';
}

function matchesFilter(row, filter, schema) {
  if (!filter || !Object.keys(filter).length) return true;
  if (Array.isArray(filter.$and)) return filter.$and.every((part) => matchesFilter(row, part, schema));
  if (Array.isArray(filter.$or)) return filter.$or.some((part) => matchesFilter(row, part, schema));
  return Object.entries(filter)
    .filter(([key]) => key !== '$and' && key !== '$or')
    .every(([key, condition]) => testCondition(propertyValue(row, key, schema), condition));
}

export function filterDatabaseRows(rows, filter, schema) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new Error('Database filter must be a JSON object');
  }
  return rows.filter((row) => matchesFilter(row, filter, schema));
}

export function sortDatabaseRows(rows, sort, schema) {
  const rules = Array.isArray(sort) ? sort : [sort];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('Each database sort rule must be an object');
    if (!rule.property || !['asc', 'desc'].includes(rule.direction)) {
      throw new Error('Each database sort rule requires property and direction asc or desc');
    }
  }
  return [...rows].sort((left, right) => {
    for (const rule of rules) {
      const a = comparable(propertyValue(left, String(rule.property), schema));
      const b = comparable(propertyValue(right, String(rule.property), schema));
      if (a === b) continue;
      const comparison = a < b ? -1 : 1;
      return rule.direction === 'asc' ? comparison : -comparison;
    }
    return 0;
  });
}

export async function queryDatabase(page, { database, spaceId, limit = 100, search = '', timeZone = 'UTC' }) {
  if (typeof page.fetchJson !== 'function') throw new Error('This Webcmd runtime does not support browser-session JSON requests');
  const payload = await page.fetchJson(`${API_ROOT}/queryCollection?src=initial_load`, {
    method: 'POST',
    headers: {
      'notion-audit-log-platform': 'web',
      'x-notion-space-id': spaceId,
    },
    body: {
      collection: { id: database.collectionId },
      collectionView: { id: database.viewId },
      source: { type: 'collection', id: database.collectionId },
      loader: {
        type: 'reducer',
        reducers: {
          collection_group_results: { type: 'results', limit, loadContentCover: true },
        },
        sort: [],
        filter: { filters: [], operator: 'and' },
        searchQuery: search,
        userTimeZone: timeZone,
      },
    },
  });
  const rawBlocks = payload?.recordMap?.block || {};
  const rowsById = new Map(Object.entries(rawBlocks).map(([id, entry]) => [notionId(id) || id, unwrapRecord(entry)]));
  const result = payload?.result?.reducerResults?.collection_group_results || {};
  const ids = result.blockIds || [...rowsById.keys()];
  return {
    rows: ids.map((id) => rowsById.get(notionId(id) || id))
      .filter(Boolean)
      .map((block, index) => ({ index, ...decodeDatabaseRow(block, database.collection.schema) })),
    hasMore: result.hasMore === true,
  };
}

export function buildDatabaseRowCreateTransaction({
  database,
  spaceId,
  properties,
  now = Date.now(),
  rowId = randomUUID(),
}) {
  const value = {
    id: rowId,
    type: 'page',
    parent_id: database.collectionId,
    parent_table: 'collection',
    space_id: spaceId,
    alive: true,
    created_time: now,
    last_edited_time: now,
    properties,
  };
  return {
    rowId,
    payload: buildTransaction(spaceId, [{
      pointer: blockPointer(rowId, spaceId),
      path: [],
      command: 'set',
      args: value,
    }], 'webcmd.notion.database-row-create'),
  };
}

export function buildDatabaseRowUpdateTransaction({ rowId, spaceId, properties, now = Date.now() }) {
  return buildTransaction(spaceId, [
    {
      pointer: blockPointer(rowId, spaceId),
      path: ['properties'],
      command: 'update',
      args: properties,
    },
    {
      pointer: blockPointer(rowId, spaceId),
      path: [],
      command: 'update',
      args: { last_edited_time: now },
    },
  ], 'webcmd.notion.database-row-update');
}

export function buildDatabaseRowDeleteTransaction({ rowId, spaceId, now = Date.now() }) {
  return buildTransaction(spaceId, [{
    pointer: blockPointer(rowId, spaceId),
    path: [],
    command: 'update',
    args: { alive: false, last_edited_time: now },
  }], 'webcmd.notion.database-row-delete');
}
