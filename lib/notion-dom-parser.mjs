export function createNotionParser(document, location = document.location) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  const uniqueRows = (rows, keyFor) => {
    const seen = new Set();
    return rows.filter((row) => {
      const key = keyFor(row);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // 画面上の改行位置で分割する。innerText があればそれを使い、
  // 未実装の環境ではブロック要素の境界を改行とみなして組み立てる
  const BLOCK_TAGS = /^(?:DIV|P|LI|UL|OL|SECTION|ARTICLE|HEADER|FOOTER|TR|BR|H[1-6])$/;
  const visualLines = (element) => {
    if (!element) return [];
    const rendered = element.innerText;
    if (typeof rendered === 'string' && rendered.includes('\n')) return rendered.split('\n');
    const parts = [];
    const walk = (node) => {
      for (const child of node.childNodes || []) {
        if (child.nodeType === 3) {
          parts.push(child.textContent || '');
          continue;
        }
        if (child.nodeType !== 1) continue;
        const isBlock = BLOCK_TAGS.test(child.tagName || '');
        if (isBlock) parts.push('\n');
        walk(child);
        if (isBlock) parts.push('\n');
      }
    };
    walk(element);
    const joined = parts.join('');
    return (joined.includes('\n') ? joined : String(element.textContent ?? '')).split('\n');
  };

  const absoluteHref = (element) => {
    const link = element?.matches?.('a[href]') ? element : element?.closest?.('a[href]');
    const href = link?.getAttribute?.('href') || '';
    if (!href || href.startsWith('javascript:')) return '';
    try {
      return new URL(href, location.href).href;
    } catch {
      return '';
    }
  };

  const authRequired = () => {
    const path = location.pathname || '';
    return /\/(?:login|signup|onboarding)(?:\/|$)/i.test(path)
      || Boolean(document.querySelector('form input[type="email"], input[name="email"]'));
  };

  const appVisible = () => Boolean(document.querySelector([
    '.notion-app-inner',
    '.notion-frame',
    '.notion-sidebar',
    '[data-notion-app]',
    '[role="tree"][aria-label*="sidebar" i]',
  ].join(',')));

  const pageRoot = () => document.querySelector([
    '.notion-page-content',
    '[data-content-id] .notion-page-content',
    'main [data-block-id]',
    'main',
  ].join(','));

  const pageTitle = () => {
    const selectors = [
      '.notion-page-block [data-content-editable-leaf]',
      '[data-block-id] [placeholder="Untitled"]',
      '[data-block-id] [placeholder="無題"]',
      'main h1',
      '[role="main"] h1',
    ];
    for (const selector of selectors) {
      const value = clean(document.querySelector(selector)?.textContent);
      if (value) return value;
    }
    return clean(document.title).replace(/\s+\|\s+Notion$/i, '') || 'Untitled';
  };

  const workspaceParts = (element) => {
    const lines = String(element?.innerText || element?.textContent || '')
      .split(/\n+/)
      .map(clean)
      .filter(Boolean);
    const accessPattern = /^(?:guest|member|owner|ゲスト|メンバー|オーナー)$/i;
    const access = lines.find((line) => accessPattern.test(line)) || '';
    const names = lines.filter((line) => !accessPattern.test(line));
    if (names.length > 1 && Array.from(names[0]).length <= 2) names.shift();
    return { title: clean(names.join(' ')), access };
  };

  const workspaceName = () => {
    const selectors = [
      '[data-testid="workspace-switcher"]',
      'nav [role="button"][aria-haspopup="dialog"]',
      '[aria-label*="workspace" i]',
      '.notion-sidebar [role="button"]',
    ];
    for (const selector of selectors) {
      const value = workspaceParts(document.querySelector(selector)).title;
      if (value && value.length <= 120) return value;
    }
    return '';
  };

  const page = () => ({
    title: clean(document.title),
    url: location.href,
    authRequired: authRequired(),
    appVisible: appVisible(),
    pageVisible: Boolean(pageRoot()),
    workspaceName: workspaceName(),
  });

  const read = (limit = 200) => {
    const root = pageRoot();
    const nodes = root
      ? Array.from(root.querySelectorAll('[data-block-id]'))
      : [];
    const blocks = uniqueRows(nodes.map((node) => {
      const text = clean(node.innerText || node.textContent);
      const className = typeof node.className === 'string' ? node.className : '';
      const typeMatch = className.match(/notion-([a-z0-9_-]+)-block/i);
      return {
        index: 0,
        id: node.getAttribute('data-block-id') || '',
        type: typeMatch?.[1] || node.getAttribute('data-block-type') || 'block',
        text,
      };
    }).filter((block) => block.text), (block) => block.id || `${block.type}:${block.text}`)
      .slice(0, limit)
      .map((block, index) => ({ ...block, index }));

    const text = blocks.length
      ? blocks.map((block) => block.text).join('\n')
      : clean(root?.innerText || root?.textContent);

    return {
      title: pageTitle(),
      url: location.href,
      text,
      blocks,
      authRequired: authRequired(),
      appVisible: appVisible(),
    };
  };

  const sidebar = (limit = 100) => {
    const selectors = [
      '.notion-sidebar [role="treeitem"]',
      '[role="tree"][aria-label*="sidebar" i] [role="treeitem"]',
      '.notion-sidebar a[href]',
      'nav a[href]',
    ];
    let nodes = [];
    for (const selector of selectors) {
      nodes = Array.from(document.querySelectorAll(selector));
      if (nodes.length) break;
    }
    return uniqueRows(nodes.map((node) => {
      const title = clean(node.getAttribute('aria-label') || node.textContent);
      const url = absoluteHref(node);
      return {
        index: 0,
        title,
        url,
        kind: /database|データベース/i.test(node.getAttribute('aria-label') || '') ? 'database' : 'page',
      };
    }).filter((row) => row.title), (row) => row.url || row.title)
      .slice(0, limit)
      .map((row, index) => ({ ...row, index }));
  };

  const favorites = (limit = 100) => {
    const explicit = document.querySelector([
      '[data-testid="favorites-section"]',
      '[data-section="favorites"]',
      '.notion-outliner-bookmarks-header-container',
    ].join(','));
    let section = explicit;
    if (section?.classList?.contains('notion-outliner-bookmarks-header-container')) {
      section = section.parentElement?.parentElement || section.parentElement;
    }
    if (!section) {
      const heading = Array.from(document.querySelectorAll('div,span')).find((node) => {
        const value = clean(node.textContent);
        return value === 'Favorites' || value === 'お気に入り';
      });
      section = heading?.parentElement?.parentElement || null;
    }
    if (!section) return [];
    const nodes = Array.from(section.querySelectorAll('[role="treeitem"], a[href]'));
    return uniqueRows(nodes.map((node) => ({
      index: 0,
      title: clean(node.getAttribute('aria-label') || node.textContent),
      url: absoluteHref(node),
    })).filter((row) => row.title && !/^(Favorites|お気に入り)$/i.test(row.title)), (row) => row.url || row.title)
      .slice(0, limit)
      .map((row, index) => ({ ...row, index }));
  };

  const links = (limit = 100) => {
    const root = pageRoot();
    if (!root) return [];
    return uniqueRows(Array.from(root.querySelectorAll('a[href]')).map((node) => ({
      index: 0,
      text: clean(node.textContent) || clean(node.getAttribute('aria-label')),
      url: absoluteHref(node),
    })).filter((row) => row.url), (row) => row.url)
      .slice(0, limit)
      .map((row, index) => ({ ...row, index }));
  };

  const search = (limit = 50) => {
    // 検索結果は listbox に入る。dialog でラップされない場合があるため listbox を優先する
    const scope = document.querySelector('[role="listbox"]')
      || document.querySelector('[role="dialog"]')
      || document;
    const nodes = Array.from(scope.querySelectorAll([
      '[role="option"]',
      '[data-testid*="search-result" i]',
      'a[href*="notion.so"]',
    ].join(',')));
    return uniqueRows(nodes.map((node) => {
      // 1 件の option には タイトル / パンくず / 更新者 / 更新日 / 本文抜粋 が縦に並ぶ。
      // textContent は改行を失って全部連結されるため、行単位に分けてから先頭行を採る
      const lines = visualLines(node)
        .map((line) => clean(line))
        .filter((line) => line && line !== '/' && line !== '•');
      const label = clean(node.getAttribute('aria-label'));
      return {
        index: 0,
        title: lines[0] || label || clean(node.textContent),
        context: lines.slice(1).join(' ').slice(0, 300),
        url: absoluteHref(node),
        kind: /database|データベース/i.test(label) ? 'database' : 'page',
      };
    }).filter((row) => row.title), (row) => row.url || row.title)
      .slice(0, limit)
      .map((row, index) => ({ ...row, index }));
  };

  const workspaces = (limit = 100) => {
    const menus = Array.from(document.querySelectorAll('[role="menu"], [role="dialog"]'));
    const menu = menus.find((candidate) => candidate.querySelector('[role="menuitem"]'));
    if (!menu) return [];
    const current = workspaceName().toLocaleLowerCase();
    const rows = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((node) => {
      const parts = workspaceParts(node);
      return {
        index: 0,
        title: parts.title,
        access: parts.access,
        current: Boolean(parts.title) && parts.title.toLocaleLowerCase() === current,
      };
    });
    const actionPattern = /^(?:add|create|join).*(?:workspace)|(?:ワークスペース).*(?:追加|作成|参加)$/i;
    return uniqueRows(rows.filter((row) => row.title && !actionPattern.test(row.title)), (row) => row.title.toLocaleLowerCase())
      .slice(0, limit)
      .map((row, index) => ({ ...row, index }));
  };

  return { page, read, sidebar, favorites, links, search, workspaces };
}

export function buildExtractScript(operation, { limit = 100 } = {}) {
  return `(() => {
    try {
      const parser = (${createNotionParser.toString()})(document, document.location);
      const handler = parser[${JSON.stringify(operation)}];
      if (typeof handler !== 'function') {
        return { ok: false, error: 'Unsupported Notion parser operation' };
      }
      return { ok: true, value: handler(${Number(limit)}) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })()`;
}
