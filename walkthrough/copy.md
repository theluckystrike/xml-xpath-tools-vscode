# Copy the XPath at the cursor

The status bar shows the XPath of the element (or attribute) at the cursor. Click it and pick a style:

| Style | Example |
|---|---|
| With positions | `/project/dependencies/dependency[2]/artifactId` |
| With id or name attributes | `/manifest/application/activity[@android:name='.SettingsActivity']` |
| Portable | `/*[local-name()='project']/*[local-name()='dependencies']` |

Each copied path selects exactly that one element when you run it here. XML: Copy XPath at Cursor copies the style set in `xmlXpathTools.copyXPathStyle`.
