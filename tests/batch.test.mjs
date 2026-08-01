import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { batchCommandNames, parseBatchDocument } from '../lib/notion-batch.mjs';

test('parses a strict batch document and resolves file paths', () => {
  const result = parseBatchDocument(JSON.stringify({
    schemaVersion: 1,
    url: 'https://www.notion.so/11111111222243338444555555555555',
    operations: [
      { id: 'add', command: 'block-add', args: { text: 'Hello', type: 'paragraph' } },
      { id: 'append', command: 'markdown-append', args: { file: './notes.md' } },
    ],
  }), { baseDir: '/tmp/batch' });
  assert.equal(result.operations.length, 2);
  assert.equal(result.operations[1].args.file, path.resolve('/tmp/batch/notes.md'));
  assert.equal(result.operations[0].destructive, false);
  assert.equal(batchCommandNames().includes('batch'), false);
});

test('rejects unknown keys, commands, duplicate ids, and invalid limits', () => {
  const base = {
    schemaVersion: 1,
    url: 'https://www.notion.so/11111111222243338444555555555555',
    operations: [{ id: 'one', command: 'block-add', args: { text: 'Hello' } }],
  };
  assert.throws(() => parseBatchDocument(JSON.stringify({ ...base, unexpected: true }), { baseDir: '/tmp' }), /unsupported keys/);
  assert.throws(() => parseBatchDocument(JSON.stringify({
    ...base,
    operations: [{ id: 'one', command: 'batch', args: {} }],
  }), { baseDir: '/tmp' }), /not supported/);
  assert.throws(() => parseBatchDocument(JSON.stringify({
    ...base,
    operations: [...base.operations, ...base.operations],
  }), { baseDir: '/tmp' }), /duplicated/);
  assert.throws(() => parseBatchDocument(JSON.stringify({ ...base, operations: [] }), { baseDir: '/tmp' }), /1 to 100/);
  assert.throws(() => parseBatchDocument('{', { baseDir: '/tmp' }), /not valid JSON/);
});

test('marks deletion as destructive and validates command-specific args', () => {
  const destructive = parseBatchDocument(JSON.stringify({
    schemaVersion: 1,
    url: 'https://www.notion.so/11111111222243338444555555555555',
    operations: [{ id: 'delete', command: 'block-delete', args: { block: '0' } }],
  }), { baseDir: '/tmp' });
  assert.equal(destructive.operations[0].destructive, true);
  assert.throws(() => parseBatchDocument(JSON.stringify({
    schemaVersion: 1,
    url: 'https://www.notion.so/11111111222243338444555555555555',
    operations: [{ id: 'bad', command: 'block-update', args: { block: '0' } }],
  }), { baseDir: '/tmp' }), /args.text/);
});
