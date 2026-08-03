import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDatabaseRowCreateTransaction,
  buildDatabaseRowDeleteTransaction,
  buildDatabaseRowUpdateTransaction,
  databaseSchemaRows,
  decodeDatabasePropertyValue,
  encodeDatabaseProperties,
  filterDatabaseRows,
  findDatabase,
  queryDatabase,
  sortDatabaseRows,
} from '../lib/notion-database.mjs';

const spaceId = '11111111-1111-4111-8111-111111111111';
const collectionId = '22222222-2222-4222-8222-222222222222';
const viewId = '33333333-3333-4333-8333-333333333333';
const rowId = '44444444-4444-4444-8444-444444444444';
const userId = '55555555-5555-4555-8555-555555555555';
const database = {
  collectionId,
  viewId,
  collection: {
    schema: {
      title: { name: 'Name', type: 'title' },
      done: { name: 'Done', type: 'checkbox' },
      tags: { name: 'Tags', type: 'multi_select' },
      status: { name: 'Status', type: 'status' },
      assignee: { name: 'Assignee', type: 'person' },
    },
  },
};

test('finds a database and exposes its schema', () => {
  const found = findDatabase({
    root: { collection_id: collectionId, view_ids: [viewId] },
    records: {},
    collections: { [collectionId]: database.collection },
    collectionViews: { [viewId]: { id: viewId, collection_id: collectionId } },
  });
  assert.equal(found.collectionId, collectionId);
  assert.deepEqual(databaseSchemaRows(found).map(({ name, type }) => ({ name, type })), [
    { name: 'Name', type: 'title' },
    { name: 'Done', type: 'checkbox' },
    { name: 'Tags', type: 'multi_select' },
    { name: 'Status', type: 'status' },
    { name: 'Assignee', type: 'person' },
  ]);
});

test('encodes supported database properties by name', () => {
  assert.deepEqual(encodeDatabaseProperties(database.collection.schema, {
    Name: 'Test row',
    Done: true,
    Tags: ['one', 'two'],
    Status: 'Done',
    Assignee: 'me',
  }, { currentUserId: userId }), {
    title: [['Test row']],
    done: [['Yes']],
    tags: [['one,two']],
    status: [['Done']],
    assignee: [['‣', [['u', userId]]]],
  });
});

test('encodes and decodes explicit Notion person IDs', () => {
  const encoded = encodeDatabaseProperties(database.collection.schema, { Assignee: userId });
  assert.equal(decodeDatabasePropertyValue(encoded.assignee, database.collection.schema.assignee), userId);
  assert.throws(
    () => encodeDatabaseProperties(database.collection.schema, { Assignee: 'User Name' }),
    /must be "me" or a Notion user ID/,
  );
});

test('queries and indexes decoded database rows', async () => {
  const page = {
    async fetchJson(url, options) {
      assert.match(url, /queryCollection/);
      assert.equal(options.body.loader.reducers.collection_group_results.limit, 10);
      return {
        result: { reducerResults: { collection_group_results: { blockIds: [rowId], hasMore: false } } },
        recordMap: {
          block: {
            [rowId]: { value: { value: { id: rowId, properties: { title: [['Test row']], done: [['Yes']] } } } },
          },
        },
      };
    },
  };
  const result = await queryDatabase(page, { database, spaceId, limit: 10 });
  assert.equal(result.rows[0].index, 0);
  assert.equal(result.rows[0].title, 'Test row');
  assert.equal(result.rows[0].properties.Done, 'Yes');
});

test('builds database create, update, and delete transactions', () => {
  const created = buildDatabaseRowCreateTransaction({
    database,
    spaceId,
    properties: { title: [['Test row']] },
    rowId,
    now: 1,
  });
  assert.equal(created.payload.transactions[0].operations[0].args.parent_table, 'collection');
  const updated = buildDatabaseRowUpdateTransaction({ rowId, spaceId, properties: { done: [['Yes']] }, now: 2 });
  assert.deepEqual(updated.transactions[0].operations[0].path, ['properties']);
  const deleted = buildDatabaseRowDeleteTransaction({ rowId, spaceId, now: 3 });
  assert.equal(deleted.transactions[0].operations[0].args.alive, false);
});

test('filters and sorts database rows with property conditions', () => {
  const rows = [
    { id: 'one', properties: { Name: 'Bravo', Done: 'No', Status: 'Todo' } },
    { id: 'two', properties: { Name: 'Alpha', Done: 'Yes', Status: 'Done' } },
    { id: 'three', properties: { Name: 'Charlie', Done: 'Yes', Status: 'Done' } },
  ];
  const filtered = filterDatabaseRows(rows, {
    $and: [
      { Status: { equals: 'Done' } },
      { Name: { contains: 'a' } },
    ],
  }, database.collection.schema);
  assert.deepEqual(filtered.map((row) => row.id), ['two', 'three']);
  assert.deepEqual(
    sortDatabaseRows(filtered, { property: 'Name', direction: 'desc' }, database.collection.schema).map((row) => row.id),
    ['three', 'two'],
  );
});
