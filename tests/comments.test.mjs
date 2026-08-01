import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommentAddTransaction,
  buildCommentResolveTransaction,
  commentRows,
  loadCurrentNotionUser,
} from '../lib/notion-comments.mjs';

const pageId = '11111111-1111-4111-8111-111111111111';
const spaceId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const discussionId = '44444444-4444-4444-8444-444444444444';
const commentId = '55555555-5555-4555-8555-555555555555';

test('normalizes comments and hides resolved discussions by default', () => {
  const data = {
    discussions: { [discussionId]: { id: discussionId, comments: [commentId], resolved: true } },
    comments: { [commentId]: { id: commentId, text: [['Hello']], created_by_id: userId, alive: true } },
    users: { [userId]: { id: userId, name: 'Tester' } },
  };
  assert.deepEqual(commentRows(data), []);
  assert.equal(commentRows(data, true)[0].author, 'Tester');
  assert.equal(commentRows(data, true)[0].text, 'Hello');
});

test('loads the current Notion user through the browser session', async () => {
  const user = await loadCurrentNotionUser({
    async fetchJson() {
      return {
        recordMap: {
          user_root: { root: { value: { value: { id: userId } } } },
          notion_user: { [userId]: { value: { value: { id: userId, name: 'Tester' } } } },
        },
      };
    },
  });
  assert.equal(user.id, userId);
});

test('builds new, reply, resolve, and reopen comment transactions', () => {
  const created = buildCommentAddTransaction({ pageId, spaceId, userId, text: 'Hello', discussionId, commentId, now: 1 });
  const operations = created.payload.transactions[0].operations;
  assert.deepEqual(operations.map((operation) => operation.pointer.table), ['discussion', 'comment', 'discussion', 'block', 'block']);
  assert.equal(operations[2].command, 'listAfter');
  const reply = buildCommentAddTransaction({ pageId, spaceId, userId, text: 'Reply', discussionId, commentId, existingDiscussion: true, now: 2 });
  assert.equal(reply.payload.transactions[0].operations.some((operation) => operation.command === 'set' && operation.pointer.table === 'discussion'), false);
  assert.equal(buildCommentResolveTransaction({ discussionId, spaceId }).transactions[0].operations[0].args.resolved, true);
  assert.equal(buildCommentResolveTransaction({ discussionId, spaceId, resolved: false }).transactions[0].operations[0].args.resolved, false);
});
