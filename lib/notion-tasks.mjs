import { randomUUID } from 'node:crypto';

const API_ROOT = 'https://app.notion.com/api/v3';

export async function enqueueNotionTask(page, { spaceId, task }) {
  if (typeof page.fetchJson !== 'function') throw new Error('This Webcmd runtime does not support browser-session JSON requests');
  const result = await page.fetchJson(`${API_ROOT}/enqueueTask`, {
    method: 'POST',
    headers: {
      'notion-audit-log-platform': 'web',
      'x-notion-space-id': spaceId,
    },
    body: { task },
  });
  if (!result?.taskId) throw new Error('enqueueTask returned no task ID');
  return result.taskId;
}

export async function getNotionTasks(page, taskIds) {
  if (typeof page.fetchJson !== 'function') throw new Error('This Webcmd runtime does not support browser-session JSON requests');
  const result = await page.fetchJson(`${API_ROOT}/getTasks`, {
    method: 'POST',
    headers: { 'notion-audit-log-platform': 'web' },
    body: { taskIds },
  });
  return result?.results || [];
}

export async function waitForNotionTask(page, taskId, { timeoutSeconds = 120 } = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let latest;
  while (Date.now() < deadline) {
    const tasks = await getNotionTasks(page, [taskId]);
    latest = tasks.find((task) => task.id === taskId) || tasks[0];
    if (latest?.state === 'success') return latest;
    if (latest?.state === 'failure') throw new Error(latest.error || 'Notion task failed');
    if (typeof page.sleep === 'function') await page.sleep(1);
    else await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Notion task timed out after ${timeoutSeconds} seconds${latest?.state ? ` in state ${latest.state}` : ''}`);
}

export function buildExportTask({
  pageId,
  spaceId,
  format,
  timeZone = 'UTC',
  locale = 'en',
  recursive = false,
  shouldExportComments = false,
  rootTaskId = randomUUID(),
}) {
  const exportType = String(format).toLowerCase();
  if (!['markdown', 'html', 'pdf'].includes(exportType)) throw new Error(`Unsupported export format: ${format}`);
  return {
    eventName: 'partitionedExportBlock',
    request: {
      block: { id: pageId, spaceId },
      recursive,
      exportOptions: {
        exportType,
        timeZone,
        locale,
        includeContents: 'everything',
        collectionViewExportType: 'currentView',
        ...(exportType === 'pdf' ? { pdfFormat: 'A4' } : {}),
      },
      shouldExportComments,
      spaceId,
      eventName: 'partitionedExportBlock',
      rootTaskId,
    },
    cellRouting: { spaceIds: [spaceId] },
  };
}

export function exportUrlFromTask(task) {
  if (task?.status?.type === 'complete' && task.status.exportURL) return task.status.exportURL;
  if (task?.status?.exportURL) return task.status.exportURL;
  throw new Error('Completed Notion export task returned no export URL');
}

export function buildDuplicateSubtreeTask({
  pageId,
  spaceId,
  parentId,
  siblingId = '',
  userId,
  timeZone = 'UTC',
  includeCollectionData = true,
}) {
  return {
    eventName: 'duplicateSubtree',
    request: {
      source: { ids: [pageId], spaceId },
      destination: {
        type: 'block',
        parent: { table: 'block', id: parentId, spaceId },
        ...(siblingId ? { siblingId } : {}),
      },
      options: {
        appendNumericTitleSuffix: true,
        resolveTemplateVariables: {
          currentUserId: userId,
          currentTimeZone: timeZone,
        },
        excludeCollectionChildren: !includeCollectionData,
        excludeTransclusionContainerChildren: false,
        isTemplateInstantiation: false,
      },
      userAction: includeCollectionData
        ? 'webcmd.notion.page-duplicate.with-data'
        : 'webcmd.notion.page-duplicate.without-data',
    },
    cellRouting: { spaceIds: [spaceId] },
  };
}

export function duplicatedPageFromTask(task) {
  const targetId = task?.status?.targetNavigableBlockId || task?.status?.targetIds?.[0];
  if (!targetId) throw new Error('Completed Notion duplicate task returned no target page ID');
  return {
    pageId: targetId,
    recordCount: Number(task?.status?.numRecordsDuplicated || 0),
  };
}
