import { marked } from 'marked';

const CALLOUTS = new Map([
  ['NOTE', { icon: '💡', color: 'blue_background' }],
  ['TIP', { icon: '✅', color: 'green_background' }],
  ['IMPORTANT', { icon: '❗', color: 'purple_background' }],
  ['WARNING', { icon: '⚠️', color: 'yellow_background' }],
  ['CAUTION', { icon: '🚨', color: 'red_background' }],
]);

function sameAnnotations(left = [], right = []) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendSegment(segments, text, annotations = []) {
  if (!text) return;
  const last = segments.at(-1);
  if (last && sameAnnotations(last[1] || [], annotations)) {
    last[0] += text;
    return;
  }
  segments.push(annotations.length ? [text, annotations] : [text]);
}

function inlineTokensToRichText(tokens, inherited = []) {
  const segments = [];
  const visit = (token, annotations) => {
    if (!token) return;
    switch (token.type) {
      case 'strong':
        for (const child of token.tokens || []) visit(child, [...annotations, ['b']]);
        break;
      case 'em':
        for (const child of token.tokens || []) visit(child, [...annotations, ['i']]);
        break;
      case 'del':
        for (const child of token.tokens || []) visit(child, [...annotations, ['s']]);
        break;
      case 'codespan':
        appendSegment(segments, token.text, [...annotations, ['c']]);
        break;
      case 'link':
        for (const child of token.tokens || []) visit(child, [...annotations, ['a', token.href]]);
        break;
      case 'image':
        appendSegment(segments, token.text || token.href, [...annotations, ['a', token.href]]);
        break;
      case 'br':
        appendSegment(segments, '\n', annotations);
        break;
      case 'escape':
        appendSegment(segments, token.text || token.raw, annotations);
        break;
      case 'html':
        appendSegment(segments, token.text || token.raw, annotations);
        break;
      case 'text':
        if (token.tokens?.length) {
          for (const child of token.tokens) visit(child, annotations);
        } else {
          appendSegment(segments, token.text ?? token.raw, annotations);
        }
        break;
      default:
        appendSegment(segments, token.text ?? token.raw ?? '', annotations);
    }
  };
  for (const token of tokens || []) visit(token, inherited);
  return segments.length ? segments : [['']];
}

function richTextFrom(text, tokens) {
  return inlineTokensToRichText(tokens?.length ? tokens : marked.Lexer.lexInline(String(text ?? '')));
}

function textBlock(type, text, tokens, extra = {}) {
  return {
    type,
    properties: { title: richTextFrom(text, tokens) },
    ...extra,
  };
}

function listItemBlocks(token) {
  const type = token.ordered ? 'numbered_list' : 'bulleted_list';
  return token.items.map((item) => {
    const nestedLists = (item.tokens || []).filter((child) => child.type === 'list');
    const directToken = (item.tokens || []).find((child) => child.type !== 'list' && child.type !== 'checkbox');
    const directText = directToken?.text || item.text || '';
    const inline = directToken?.tokens || marked.Lexer.lexInline(directText);
    const block = textBlock(item.task ? 'to_do' : type, directText, inline);
    if (item.task) block.properties.checked = [[item.checked ? 'Yes' : 'No']];
    const children = nestedLists.flatMap(listItemBlocks);
    if (children.length) block.children = children;
    return block;
  });
}

function tableFallback(token) {
  const header = token.header.map((cell) => cell.text).join(' | ');
  const separator = token.header.map(() => '---').join(' | ');
  const rows = token.rows.map((row) => row.map((cell) => cell.text).join(' | '));
  const content = [header, separator, ...rows].join('\n');
  return textBlock('code', content, undefined, {
    properties: {
      title: [[content]],
      language: [['markdown']],
    },
  });
}

function convertToken(token) {
  switch (token.type) {
    case 'heading': {
      const type = token.depth === 1 ? 'header' : token.depth === 2 ? 'sub_header' : 'sub_sub_header';
      return [textBlock(type, token.text, token.tokens)];
    }
    case 'paragraph':
      return [textBlock('text', token.text, token.tokens)];
    case 'text':
      return [textBlock('text', token.text, token.tokens)];
    case 'list':
      return listItemBlocks(token);
    case 'blockquote': {
      const callout = String(token.text || '').match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*([\s\S]*)$/i);
      if (callout) {
        const style = CALLOUTS.get(callout[1].toUpperCase());
        return [textBlock('callout', callout[2], undefined, {
          format: { page_icon: style.icon, block_color: style.color },
        })];
      }
      return [textBlock('quote', token.text, undefined)];
    }
    case 'code':
      return [{
        type: 'code',
        properties: {
          title: [[token.text || '']],
          language: [[token.lang || 'plain text']],
        },
      }];
    case 'hr':
      return [{ type: 'divider', properties: {} }];
    case 'table':
      return [tableFallback(token)];
    case 'html':
      return [textBlock('code', token.text || token.raw, undefined, {
        properties: {
          title: [[token.text || token.raw || '']],
          language: [['html']],
        },
      })];
    case 'space':
      return [];
    default:
      return token.text ? [textBlock('text', token.text, token.tokens)] : [];
  }
}

export function markdownToNotionBlocks(markdown) {
  const source = String(markdown ?? '');
  if (!source.trim()) return [];
  const tokens = marked.lexer(source, { gfm: true, breaks: false });
  return tokens.flatMap(convertToken);
}

export function summarizeNotionBlocks(blocks) {
  const counts = {};
  const visit = (block) => {
    counts[block.type] = (counts[block.type] || 0) + 1;
    for (const child of block.children || []) visit(child);
  };
  for (const block of blocks) visit(block);
  return counts;
}
