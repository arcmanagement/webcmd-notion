import test from 'node:test';
import assert from 'node:assert/strict';
import { diffNotionBlocks, flattenExpectedBlocks } from '../lib/notion-diff.mjs';

test('flattens nested expected blocks and reports an equal page', () => {
  const expected = [{
    type: 'bulleted_list',
    properties: { title: [['Parent']] },
    children: [{ type: 'bulleted_list', properties: { title: [['Child']] } }],
  }];
  assert.deepEqual(flattenExpectedBlocks(expected), [
    { type: 'bulleted_list', text: 'Parent', depth: 0, checked: '', language: '', icon: '', color: '' },
    { type: 'bulleted_list', text: 'Child', depth: 1, checked: '', language: '', icon: '', color: '' },
  ]);
  const result = diffNotionBlocks([
    { type: 'bulleted_list', text: 'Parent', depth: 0 },
    { type: 'bulleted_list', text: 'Child', depth: 1 },
  ], expected);
  assert.equal(result.equal, true);
  assert.deepEqual(result.changes, []);
});

test('reports changed, added, and removed block positions', () => {
  const changed = diffNotionBlocks(
    [{ type: 'text', text: 'Old', depth: 0 }],
    [{ type: 'text', properties: { title: [['New']] } }, { type: 'divider', properties: {} }],
  );
  assert.equal(changed.equal, false);
  assert.equal(changed.changed, 1);
  assert.equal(changed.added, 1);
  assert.equal(changed.removed, 0);

  const removed = diffNotionBlocks(
    [{ type: 'text', text: 'One', depth: 0 }, { type: 'text', text: 'Two', depth: 0 }],
    [{ type: 'text', properties: { title: [['One']] } }],
  );
  assert.equal(removed.removed, 1);
});
