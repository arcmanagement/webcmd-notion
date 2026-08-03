import path from 'node:path';

const COMMANDS = {
  'block-add': { keys: ['text', 'type'], required: ['text'] },
  'block-delete': { keys: ['block'], required: ['block'], destructive: true },
  'block-duplicate': { keys: ['block'], required: ['block'] },
  'block-indent': { keys: ['block'], required: ['block'] },
  'block-move': { keys: ['after', 'block'], required: ['after', 'block'] },
  'block-outdent': { keys: ['block'], required: ['block'] },
  'block-update': { keys: ['block', 'text'], required: ['block', 'text'] },
  'markdown-append': { keys: ['file'], required: ['file'], fileKeys: ['file'] },
  rename: { keys: ['title'], required: ['title'] },
};

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unsupported keys: ${unknown.join(', ')}`);
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function parseBatchDocument(text, { baseDir, overrideUrl = '' } = {}) {
  let document;
  try {
    document = JSON.parse(String(text ?? ''));
  } catch (error) {
    throw new Error(`Batch file is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  assertObject(document, 'Batch document');
  assertExactKeys(document, ['schemaVersion', 'url', 'operations'], 'Batch document');
  if (document.schemaVersion !== 1) throw new Error('Batch schemaVersion must be 1');
  const url = requireString(overrideUrl || document.url, 'Batch url');
  if (!Array.isArray(document.operations) || document.operations.length < 1 || document.operations.length > 100) {
    throw new Error('Batch operations must contain from 1 to 100 entries');
  }
  const ids = new Set();
  const operations = document.operations.map((operation, index) => {
    const label = `Batch operation ${index}`;
    assertObject(operation, label);
    assertExactKeys(operation, ['id', 'command', 'args'], label);
    const id = requireString(operation.id, `${label} id`);
    if (ids.has(id)) throw new Error(`Batch operation id is duplicated: ${id}`);
    ids.add(id);
    const command = requireString(operation.command, `${label} command`);
    const definition = COMMANDS[command];
    if (!definition) throw new Error(`Batch command is not supported: ${command}`);
    const args = operation.args ?? {};
    assertObject(args, `${label} args`);
    assertExactKeys(args, definition.keys, `${label} args`);
    for (const key of definition.required || []) requireString(args[key], `${label} args.${key}`);
    for (const [key, value] of Object.entries(args)) {
      if (typeof value !== 'string') throw new Error(`${label} args.${key} must be a string`);
    }
    const normalizedArgs = { ...args };
    for (const key of definition.fileKeys || []) {
      const file = requireString(args[key], `${label} args.${key}`);
      normalizedArgs[key] = path.resolve(baseDir, file);
    }
    return { id, command, args: normalizedArgs, destructive: definition.destructive === true };
  });
  return { schemaVersion: 1, url, operations };
}

export function batchCommandNames() {
  return Object.keys(COMMANDS);
}
