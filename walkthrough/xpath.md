# Evaluate XPath

Click the search button in the editor title, or run XML: Evaluate XPath from the Command Palette.

- XPath 1.0 with the prefixes declared in the file: `//soap:Body/m:GetStockPrice`
- Names without a prefix also match elements in a default namespace, so `//dependency/artifactId` works in a `pom.xml`. Turn on `xmlXpathTools.xpath.strictNamespaces` for strict XPath 1.0.
- Numbers, strings and booleans show as one line: `count(//dependency)`
- Results list with line numbers in XPath Results. Click one to jump to it, or right-click to copy its value or its XPath.

Entities are never expanded and nothing is read from disk or the network.
