# webcmd-plugin-notion

Notion commands for Webcmd. The plugin reuses a Webcmd profile's persistent
browser session, so Slack and Notion can stay signed in under the same isolated
profile without API tokens.

## Install

```bash
webcmd plugin install file:///absolute/path/to/webcmd-notion
```

## Login

Authentication is the only operation that needs a visible browser window.

```bash
webcmd --profile orangemoon notion login --window foreground
webcmd --profile orangemoon notion whoami --window background -f json
```

## Commands

| Command | Purpose |
| --- | --- |
| `notion login [url]` | Open Notion sign-in for the selected profile |
| `notion whoami` | Verify the current login and workspace |
| `notion page [url]` | Inspect authentication and page state |
| `notion read <url>` | Read normalized page text and blocks through the browser session |
| `notion blocks <url>` | List blocks with stable IDs and nesting depth |
| `notion create <parent> <title>` | Create a child page under a parent page |
| `notion page-move <url> <parent>` | Move a page under another page |
| `notion page-duplicate <url>` | Duplicate the full page subtree, including database rows |
| `notion page-archive <url> --yes` | Move a page to Notion Trash |
| `notion page-restore <url>` | Restore a page from Notion Trash |
| `notion page-export <url>` | Export Markdown, HTML, or PDF with `--export-type` |
| `notion page-diff <url> <file>` | Compare page blocks with Markdown |
| `notion block-add <url> <text>` | Append a paragraph or another basic block type |
| `notion block-update <url> <block> <text>` | Replace block text by ID or index |
| `notion block-move <url> <block>` | Move a top-level block after another block |
| `notion block-delete <url> <block> --yes` | Delete a block and its descendants |
| `notion block-duplicate <url> <block>` | Duplicate a block and its descendants |
| `notion block-indent <url> <block>` | Nest a block under its previous sibling |
| `notion block-outdent <url> <block>` | Move a nested block after its parent |
| `notion rename <url> <title>` | Rename a page |
| `notion markdown-set <url> <file>` | Replace page content from a Markdown file |
| `notion markdown-append <url> <file>` | Append Markdown blocks |
| `notion image-add <url> <file>` | Upload a local image and append it to a page |
| `notion image-replace <url> <block> <file>` | Replace an existing image binary |
| `notion file-add <url> <file>` | Upload and append a local file |
| `notion file-download <url> <block>` | Download an image or file block |
| `notion database-schema <url>` | List database properties |
| `notion database-query <url>` | Search, filter, and sort rows from a database view |
| `notion database-row-create <url> <title>` | Create a database row |
| `notion database-row-update <url> <row>` | Update database row properties |
| `notion database-row-delete <url> <row> --yes` | Delete a database row |
| `notion comment-list <url>` | List page comments |
| `notion comment-add <url> <text>` | Add a comment or reply |
| `notion comment-resolve <url> <discussion>` | Resolve or reopen a discussion |
| `notion batch <file>` | Run a validated sequential operation file |
| `notion search <query>` | Search through Notion Quick Find |
| `notion sidebar [url]` | List visible sidebar pages and databases |
| `notion favorites [url]` | List visible Favorites pages |
| `notion links <url>` | List links from a page |
| `notion workspaces [url]` | List available workspaces and the current selection |
| `notion workspace <name>` | Switch the current workspace by name |

All commands except `login` default to background mode. On macOS, cold
background profiles run headless and do not create a browser window.

Page, block, Markdown, image, file, database, comment, and export commands send
Notion's internal requests from inside the signed-in Chromium page. The browser
attaches its session cookies itself; the plugin does not print or persist those
cookies. Authentication, workspace switching, and Quick Find remain UI
operations because Notion does not expose stable equivalents for them.

Create a child page with an optional first paragraph:

```bash
webcmd --profile orangemoon notion create \
  'https://app.notion.com/p/example/00000000000000000000000000000000' \
  'CLI test page' \
  --content 'Created from the signed-in browser session'
```

Inspect and edit blocks:

```bash
webcmd --profile orangemoon notion blocks '<page-url>' -f json
webcmd --profile orangemoon notion block-add '<page-url>' 'New paragraph'
webcmd --profile orangemoon notion block-update '<page-url>' 0 'Replacement text'
webcmd --profile orangemoon notion block-move '<page-url>' 10 --after 2
webcmd --profile orangemoon notion rename '<page-url>' 'New title'
```

Replace a page body from Markdown:

```bash
webcmd --profile orangemoon notion markdown-set '<page-url>' ./document.md
webcmd --profile orangemoon notion markdown-append '<page-url>' ./appendix.md
```

Upload a local image without opening the browser GUI:

```bash
webcmd --profile orangemoon notion image-add \
  '<page-url>' \
  ./image.png \
  --caption 'Optional caption' \
  --window background
```

Work with comments and databases:

```bash
webcmd --profile orangemoon notion comment-add '<page-url>' 'Please review this'
webcmd --profile orangemoon notion comment-list '<page-url>' --include-resolved
webcmd --profile orangemoon notion database-schema '<database-url>'
webcmd --profile orangemoon notion database-query \
  '<database-url>' \
  --filter '{"Status":{"equals":"Done"}}' \
  --sort '{"property":"Name","direction":"asc"}'
webcmd --profile orangemoon notion database-row-create \
  '<database-url>' \
  'CLI row' \
  --properties '{"Status":"Done"}'
```

Export and compare pages:

```bash
webcmd --profile orangemoon notion page-export \
  '<page-url>' \
  --export-type pdf \
  --output ./page.pdf
webcmd --profile orangemoon notion page-diff '<page-url>' ./expected.md
```

`database-query --filter` accepts property names or IDs. A filter object is an
AND condition by default and supports `$and`, `$or`, `equals`, `notEquals`,
`contains`, `startsWith`, `endsWith`, `in`, `notIn`, numeric comparisons, and
`isEmpty`. Sort accepts one rule or an array of rules.

Batch files use a strict versioned JSON schema. Execution is sequential and is
not atomic. The runner stops after the first failure and reports completed step
IDs. `block-delete` also requires `--allow-destructive` at the batch command.

```json
{
  "schemaVersion": 1,
  "url": "https://www.notion.so/00000000000000000000000000000000",
  "operations": [
    {
      "id": "append-note",
      "command": "block-add",
      "args": { "text": "Created by batch", "type": "paragraph" }
    }
  ]
}
```

```bash
webcmd --profile orangemoon notion batch ./operations.json --dry-run
webcmd --profile orangemoon notion batch ./operations.json
```

Markdown conversion supports headings, paragraphs, bold, italic,
strikethrough, inline code, links, nested bulleted lists, numbered lists, task
lists, quotes, GitHub-style callouts, fenced code blocks, and dividers. Markdown
tables currently become fenced Markdown code blocks because Notion's private
table transaction format needs separate handling.

The write path uses Notion's private web-app protocol, not the public Notion
API. If that protocol changes, commands fail with an explicit compatibility
error instead of silently returning incomplete data or switching to UI
automation. Destructive block, page, and database operations require an
explicit confirmation flag.

## Development

```bash
npm install
npm test
webcmd validate notion
```

The login command opens `https://www.notion.com/login`; page URLs on
`notion.com`, `notion.so`, and `notion.site` are accepted.

The reusable internal request, response, and secure upload code lives in
`lib/notion-internal-api.mjs`. UI-only extraction remains in
`lib/notion-dom-parser.mjs`. If Notion changes either contract, commands fail
explicitly instead of returning a silent empty success.
