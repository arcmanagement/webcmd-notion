function richTextToPlain(value) {
  if (!Array.isArray(value)) return '';
  return value.map((segment) => Array.isArray(segment) ? String(segment[0] ?? '') : '').join('');
}

export function flattenExpectedBlocks(blocks, depth = 0, output = []) {
  for (const block of blocks || []) {
    output.push({
      type: block.type || 'block',
      text: richTextToPlain(block.properties?.title),
      depth,
      checked: richTextToPlain(block.properties?.checked),
      language: richTextToPlain(block.properties?.language),
      icon: block.format?.page_icon || '',
      color: block.format?.block_color || '',
    });
    flattenExpectedBlocks(block.children || [], depth + 1, output);
  }
  return output;
}

export function diffNotionBlocks(actualBlocks, expectedBlocks) {
  const actual = (actualBlocks || []).map((block) => ({
    type: block.type,
    text: block.text || '',
    depth: block.depth || 0,
    checked: block.checked || '',
    language: block.language || '',
    icon: block.icon || '',
    color: block.color || '',
  }));
  const expected = flattenExpectedBlocks(expectedBlocks);
  const changes = [];
  const total = Math.max(actual.length, expected.length);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (let index = 0; index < total; index += 1) {
    const actualBlock = actual[index];
    const expectedBlock = expected[index];
    if (!actualBlock) {
      added += 1;
      changes.push({ index, status: 'add', expected: expectedBlock, actual: null });
      continue;
    }
    if (!expectedBlock) {
      removed += 1;
      changes.push({ index, status: 'remove', expected: null, actual: actualBlock });
      continue;
    }
    if (
      actualBlock.type !== expectedBlock.type
      || actualBlock.text !== expectedBlock.text
      || actualBlock.depth !== expectedBlock.depth
      || actualBlock.checked !== expectedBlock.checked
      || actualBlock.language !== expectedBlock.language
      || actualBlock.icon !== expectedBlock.icon
      || actualBlock.color !== expectedBlock.color
    ) {
      changed += 1;
      changes.push({ index, status: 'change', expected: expectedBlock, actual: actualBlock });
    }
  }
  return {
    equal: changes.length === 0,
    actualCount: actual.length,
    expectedCount: expected.length,
    added,
    removed,
    changed,
    changes,
  };
}
