import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDuplicateSubtreeTask,
  buildExportTask,
  duplicatedPageFromTask,
  enqueueNotionTask,
  exportUrlFromTask,
  waitForNotionTask,
} from '../lib/notion-tasks.mjs';

const pageId = '11111111-1111-4111-8111-111111111111';
const spaceId = '22222222-2222-4222-8222-222222222222';

test('builds markdown, html, and PDF export tasks', () => {
  for (const format of ['markdown', 'html', 'pdf']) {
    const task = buildExportTask({ pageId, spaceId, format, recursive: true, shouldExportComments: true });
    assert.equal(task.eventName, 'partitionedExportBlock');
    assert.equal(task.request.exportOptions.exportType, format);
    assert.equal(task.request.recursive, true);
    assert.equal(task.request.shouldExportComments, true);
    assert.equal(task.request.exportOptions.pdfFormat, format === 'pdf' ? 'A4' : undefined);
  }
});

test('enqueues, polls, and reads an export URL', async () => {
  let polls = 0;
  const page = {
    async fetchJson(url, options) {
      if (url.endsWith('/enqueueTask')) {
        assert.equal(options.body.task.eventName, 'partitionedExportBlock');
        return { taskId: 'task-1' };
      }
      polls += 1;
      return { results: [{ id: 'task-1', state: polls > 1 ? 'success' : 'in_progress', status: polls > 1 ? { type: 'complete', exportURL: 'https://example.com/export.zip' } : {} }] };
    },
    async sleep() {},
  };
  const taskId = await enqueueNotionTask(page, { spaceId, task: buildExportTask({ pageId, spaceId, format: 'markdown' }) });
  const result = await waitForNotionTask(page, taskId, { timeoutSeconds: 1 });
  assert.equal(exportUrlFromTask(result), 'https://example.com/export.zip');
});

test('builds and reads a full subtree duplicate task', () => {
  const task = buildDuplicateSubtreeTask({
    pageId,
    spaceId,
    parentId: '33333333-3333-4333-8333-333333333333',
    siblingId: pageId,
    userId: '44444444-4444-4444-8444-444444444444',
    timeZone: 'Asia/Tokyo',
  });
  assert.equal(task.eventName, 'duplicateSubtree');
  assert.equal(task.request.options.excludeCollectionChildren, false);
  assert.equal(task.request.destination.siblingId, pageId);
  assert.deepEqual(duplicatedPageFromTask({
    status: { targetNavigableBlockId: '55555555-5555-4555-8555-555555555555', numRecordsDuplicated: 12 },
  }), {
    pageId: '55555555-5555-4555-8555-555555555555',
    recordCount: 12,
  });
});
