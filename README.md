# Format XML & XPath Tools (XML Formatter, Tree View, Minify)

![License MIT](https://img.shields.io/badge/license-MIT-blue)
![Works offline](https://img.shields.io/badge/network-none-green)
![VS Code 1.90+](https://img.shields.io/badge/VS%20Code-1.90%2B-007ACC)

Format XML without changing its text, run XPath with the namespaces in the file, and copy an XPath that selects the element under the cursor. Free, no sign-in, works offline.

![HERO_ALT](https://github.com/theluckystrike/xml-xpath-tools-vscode/raw/HEAD/images/pom-xpath-tree.png)

*HERO_CAPTION*

- Format Document and Minify XML change only the whitespace between tags. Text, CDATA, comments, `xml:space="preserve"` and attribute values stay byte for byte, and a second format changes nothing.
- XPath 1.0 runs on the file's own prefixes, and plain names also match a default namespace, so `//dependency/artifactId` works in a `pom.xml`. Results list with line numbers; click one to jump to it.
- The status bar shows the XPath at the cursor. Click it to copy the path with positions, with id or name attributes, or in a portable `local-name()` form.
- Big files parse in a background thread. In the tests, a 49 MB file with about 1 million elements formatted in 1.6 seconds, and a 13.5 MB file on one line in 0.7 seconds, while the editor's thread never paused for more than 0.1 seconds.
- The XML Tree view in the Explorer follows the cursor, and Problems lists well-formedness errors with their line and column.

## Quick start

1. Install Format XML & XPath Tools.
2. Open an XML file and press Shift+Alt+F (Shift+Option+F on a Mac). If you have more than one XML formatter, VS Code asks which one to use.
3. Click the search button in the editor title to run an XPath, or click the XPath in the status bar to copy it.

"XML: Get Started" in the Command Palette opens a short tour with a sample file.

## Why this one

People who format XML and use XPath in VS Code report the same problems again and again. Each row links the public report and says what this extension does about it. The numbers come from the tests in `test/` and the release check in a real VS Code (`scripts/e2e-vscode.mjs`).

| Reported problem | What this extension does |
|---|---|
| Formatting a large or single-line file never finishes, or blocks the editor ([#266](https://github.com/DotJoshJohnson/vscode-xml/issues/266), [#309](https://github.com/DotJoshJohnson/vscode-xml/issues/309), [#336](https://github.com/DotJoshJohnson/vscode-xml/issues/336), [review, May 2026](https://marketplace.visualstudio.com/items?itemName=DotJoshJohnson.xml&ssr=false#review-details)) | Formatting, the tree and XPath run in a worker thread, so the editor keeps working. Measured in `test/large.test.js` and `test/format.test.js`: 49 MB (1,049,601 elements) formatted in 1.6 s and indexed in 1.1 s; a 13.5 MB single-line file formatted in 0.7 s. Files over 50 MB, which VS Code does not pass to extensions, format on disk. |
| "Get current XPath" returns a path that does not exist, and Evaluate gives no output ([#310](https://github.com/DotJoshJohnson/vscode-xml/issues/310), [#377](https://github.com/DotJoshJohnson/vscode-xml/issues/377), [reviews, 2023 and 2024](https://marketplace.visualstudio.com/items?itemName=DotJoshJohnson.xml&ssr=false#review-details)) | The copied path is checked in the tests: for every sampled element in 22 files (11 samples and 11 real files such as an Apache `pom.xml`, a CycloneDX XSD, Android, XLIFF and .resx files), each of the 3 styles selects that one element and nothing else. XPath errors say what is wrong, for example which prefixes the file declares. |
| Formatting changes content: a space in `<t> </t>` is lost, `xml:space="preserve"` is ignored, spaces pile up before CDATA, comment indentation grows on every save ([#386](https://github.com/DotJoshJohnson/vscode-xml/issues/386), [#303](https://github.com/DotJoshJohnson/vscode-xml/issues/303), [#381](https://github.com/DotJoshJohnson/vscode-xml/issues/381), [#365](https://github.com/DotJoshJohnson/vscode-xml/issues/365)) | Text, CDATA, comments and preserved content are copied as they are. Each of those four reports is a test case in `test/format.test.js`, and every sample file is formatted twice to check that the second run changes nothing. |
| A broken file gets no message, or Format inserts tags of its own ([#335](https://github.com/DotJoshJohnson/vscode-xml/issues/335), [review, 2018](https://marketplace.visualstudio.com/items?itemName=DotJoshJohnson.xml&ssr=false#review-details)) | A file that is not well formed is never changed. Format shows the error with its line and column, and Problems lists it as you type. |
| The tree view does not show up ([#367](https://github.com/DotJoshJohnson/vscode-xml/issues/367)) | XML Tree appears in the Explorer whenever an XML file is active, and "XML: Show XML Tree" opens it. |

Zovo makes and maintains this extension on its own. It does not replace, and is not affiliated with, any other XML extension.

## Format and minify

- Format Document and Format Selection use the editor's tab size and spaces or tabs setting, and keep the file's line endings, its byte order mark and its final newline.
- Only whitespace between tags changes, in elements that hold tags and no text. An element with text in it, such as `<p>Some <b>bold</b> text</p>`, stays on its line as written.
- Attributes keep their values and quotes. With the default `keep` layout, a tag that already has one attribute per line keeps that layout; `oneLine` and `onePerLine` are the other choices.
- One empty line is kept where the file had empty lines between elements.
- "XML: Minify XML" removes the whitespace between tags in the file or the selection. Comments stay unless `xmlXpathTools.minify.removeComments` is on.
- Files over 50 MB: VS Code does not pass them to extensions. Right-click the file in the Explorer and pick "Format Large XML File on Disk". It writes `name.formatted.xml` next to it, or replaces the file after you confirm.

## XPath

- Click the search button in the editor title, or run "XML: Evaluate XPath". The last 20 expressions are kept per workspace.
- Prefixes come from the file: `//soap:Body/m:GetStockPrice`. When a prefix is not declared, the message lists the ones that are.
- Plain names also match elements in a default namespace (pom.xml, SVG, XAML, .csproj, KML). Turn on `xmlXpathTools.xpath.strictNamespaces` for strict XPath 1.0.
- Node results list in XPath Results with their line. Click to select the tag or attribute in the editor; right-click to copy the value or the node's XPath. Numbers, strings and booleans show on one line.

## Copy XPath

| Style | Example |
|---|---|
| With positions | `/project/dependencies/dependency[2]/artifactId` |
| With id or name attributes | `/manifest/application/activity[@android:name='.SettingsActivity']` |
| Portable | `/*[local-name()='project']/*[local-name()='dependencies']/*[local-name()='dependency'][2]` |

With the cursor on an attribute, the path ends in `/@name`. Positions count only siblings that the same name test matches, so the path selects one element. When a prefix is bound to two different namespaces in one file, the step uses `local-name()` and `namespace-uri()` instead.

## Safety

- No network code: the bundles load no HTTP or socket module, and a test checks it.
- Entities are never expanded and DTDs are never loaded. An entity bomb ("billion laughs") is measured, not expanded, and gets a warning; an external entity such as `file:///etc/passwd` is not read.
- Nothing changes your settings. Format runs only when you ask for it or when you turn on `editor.formatOnSave` yourself.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `xmlXpathTools.format.attributes` | `keep` | `keep`, `oneLine` or `onePerLine` |
| `xmlXpathTools.format.keepBlankLines` | `true` | Keep one empty line between elements |
| `xmlXpathTools.minify.removeComments` | `false` | Minify also removes comments |
| `xmlXpathTools.xpath.strictNamespaces` | `false` | Strict XPath 1.0 names |
| `xmlXpathTools.xpath.maxResults` | `5000` | Most results listed |
| `xmlXpathTools.copyXPathStyle` | `indexed` | `indexed`, `predicates` or `portable` |
| `xmlXpathTools.statusBar.showXPath` | `true` | XPath at the cursor in the status bar |
| `xmlXpathTools.tree.syncWithCursor` | `true` | The tree follows the cursor |
| `xmlXpathTools.validate` | `true` | Well-formedness errors in Problems |
| `xmlXpathTools.maxFileMB` | `60` | Largest file for the tree, XPath and checks |

## Limits

- XPath 1.0 only. There is no XPath 2.0 or 3.1, XQuery or XSLT.
- It checks that a file is well formed. It does not validate against an XSD or a DTD.
- Files over 50 MB can be formatted on disk, but VS Code does not give them to extensions, so the tree and XPath do not run on them.
- The on-disk command reads UTF-8, UTF-16 with a byte order mark and ISO-8859-1.

## Support Zovo

Zovo extensions are free, with no ads and no tracking. They are made by [theluckystrike](https://github.com/theluckystrike) on GitHub. If this one saves you time, you can support the work:

- [Sponsor on GitHub](https://github.com/sponsors/theluckystrike)
- [Follow theluckystrike on GitHub](https://github.com/theluckystrike)

## More tools by Zovo

- [Large JSON Viewer, JSON Browser & JSON Tree](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-json-tree-viewer) shows large JSON files as a searchable tree, copies JSONPath and turns arrays of objects into a table.
- [HAR Viewer & HAR File Analyzer (HTTP Archive, Network Log)](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-har-viewer) opens HAR files from browser DevTools with a timing waterfall, filters and a redacted copy for sharing.
- [Hex Viewer & Binary Viewer, Hex Editor (Large Files)](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-hex-viewer) Hex viewer, binary viewer and hex editor for VS Code that opens files of any size (4 GB and more) in under a second. Insert and delete bytes, compare two files byte by byte, go to offset, find hex or text, a data inspector, copy as C array or base64. Free, works offline.
- [JSONL Viewer, Large JSONL Table & NDJSON Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-jsonl-viewer) opens JSONL and NDJSON files as a table, as records or as a chat view.
- [SQLite DB Viewer & SQLite Viewer, Database Viewer (Read-Only)](https://marketplace.visualstudio.com/items?itemName=zovo.sqlite-table-viewer) browses SQLite tables read-only and runs SELECT queries.

See [all Zovo extensions on the Marketplace](https://marketplace.visualstudio.com/publishers/zovo).
