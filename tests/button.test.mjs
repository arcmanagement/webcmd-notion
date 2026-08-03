import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { buildButtonProbeScript, buttonProbeError } from '../lib/notion-button.mjs';

function evaluate(html, label, mark = false) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 30 });
  return JSON.parse(JSON.stringify(dom.window.eval(buildButtonProbeScript(label, { mark }))));
}

test('matches one visible button by exact normalized text', () => {
  const result = evaluate('<button>  Devin に開発依頼  </button>', 'Devin に開発依頼', true);
  assert.deepEqual(result, {
    label: 'Devin に開発依頼',
    exactMatches: 1,
    enabled: true,
    marked: true,
  });
});

test('rejects partial, duplicate, and disabled button matches', () => {
  assert.equal(evaluate('<button>Devin に開発依頼する</button>', 'Devin に開発依頼').exactMatches, 0);
  assert.match(buttonProbeError(evaluate('<button>実行</button><button>実行</button>', '実行')), /ambiguous/);
  assert.match(buttonProbeError(evaluate('<button disabled>実行</button>', '実行')), /disabled/);
});

test('accepts an exact aria label', () => {
  const result = evaluate('<div role="button" aria-label="仕様策定を開始">表示名</div>', '仕様策定を開始');
  assert.equal(result.exactMatches, 1);
  assert.equal(result.enabled, true);
});
