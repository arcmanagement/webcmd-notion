import { randomUUID } from 'node:crypto';
import { buildTransaction, notionId, richTextToPlain, unwrapRecord } from './notion-internal-api.mjs';

const API_ROOT = 'https://app.notion.com/api/v3';

function pointer(table, id, spaceId) {
  return { table, id, spaceId };
}

export function commentRows(pageData, includeResolved = false) {
  const discussions = Object.values(pageData.discussions || {})
    .filter((discussion) => includeResolved || discussion.resolved !== true);
  const comments = pageData.comments || {};
  const users = pageData.users || {};
  const rows = [];
  for (const discussion of discussions) {
    for (const commentId of discussion.comments || []) {
      const normalized = notionId(commentId) || commentId;
      const comment = comments[normalized];
      if (!comment || comment.alive === false) continue;
      const author = users[notionId(comment.created_by_id) || comment.created_by_id];
      rows.push({
        index: rows.length,
        discussionID: notionId(discussion.id) || discussion.id,
        commentID: normalized,
        text: richTextToPlain(comment.text),
        resolved: discussion.resolved === true,
        author: author?.name || author?.email || comment.created_by_id || '',
        createdTime: comment.created_time || null,
        lastEditedTime: comment.last_edited_time || null,
      });
    }
  }
  return rows;
}

export async function loadCurrentNotionUser(page) {
  if (typeof page.fetchJson !== 'function') throw new Error('This Webcmd runtime does not support browser-session JSON requests');
  const payload = await page.fetchJson(`${API_ROOT}/loadUserContent`, {
    method: 'POST',
    headers: { 'notion-audit-log-platform': 'web' },
    body: {},
  });
  const roots = Object.values(payload?.recordMap?.user_root || {}).map(unwrapRecord).filter(Boolean);
  const users = Object.entries(payload?.recordMap?.notion_user || {})
    .map(([id, entry]) => [notionId(id) || id, unwrapRecord(entry)])
    .filter(([, user]) => user);
  const rootUserId = notionId(roots[0]?.id) || roots[0]?.id;
  const match = users.find(([id]) => id === rootUserId) || users[0];
  if (!match) throw new Error('Notion current user record was not returned');
  return { id: match[0], ...match[1] };
}

export function buildCommentAddTransaction({
  pageId,
  spaceId,
  userId,
  text,
  discussionId = randomUUID(),
  commentId = randomUUID(),
  existingDiscussion = false,
  now = Date.now(),
}) {
  const operations = [];
  if (!existingDiscussion) {
    operations.push(
      {
        pointer: pointer('discussion', discussionId, spaceId),
        path: [],
        command: 'set',
        args: {
          id: discussionId,
          version: 1,
          parent_id: pageId,
          parent_table: 'block',
          resolved: false,
          type: 'default',
          space_id: spaceId,
        },
      },
    );
  }
  operations.push(
    {
      pointer: pointer('comment', commentId, spaceId),
      path: [],
      command: 'set',
      args: {
        id: commentId,
        version: 1,
        parent_id: discussionId,
        parent_table: 'discussion',
        alive: true,
        space_id: spaceId,
        created_time: now,
        last_edited_time: now,
        created_by_id: userId,
        created_by_table: 'notion_user',
        text: [[text]],
      },
    },
    {
      pointer: pointer('discussion', discussionId, spaceId),
      path: ['comments'],
      command: 'listAfter',
      args: { id: commentId },
    },
    ...(!existingDiscussion ? [{
      pointer: pointer('block', pageId, spaceId),
      path: ['discussions'],
      command: 'listAfter',
      args: { id: discussionId },
    }] : []),
    {
      pointer: pointer('block', pageId, spaceId),
      path: [],
      command: 'update',
      args: { last_edited_time: now },
    },
  );
  return {
    discussionId,
    commentId,
    payload: buildTransaction(spaceId, operations, 'webcmd.notion.comment-add'),
  };
}

export function buildCommentResolveTransaction({ discussionId, spaceId, resolved = true }) {
  return buildTransaction(spaceId, [{
    pointer: pointer('discussion', discussionId, spaceId),
    path: [],
    command: 'update',
    args: { resolved },
  }], 'webcmd.notion.comment-resolve');
}
