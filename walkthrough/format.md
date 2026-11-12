# Format or minify XML

Run Format Document (Shift+Alt+F, or Shift+Option+F on a Mac) in any XML file. If another formatter is set, VS Code asks which one to use.

What the formatter changes: the line breaks and indentation between tags in elements that hold only tags.

What it never changes:

- text, including leading and trailing spaces (`<t> </t>` stays as it is)
- CDATA sections, comments, processing instructions and the DOCTYPE
- anything inside `xml:space="preserve"`
- attribute values and their quotes

A file with an error is not changed: you get the line and column of the error instead.

XML: Minify XML removes the whitespace between tags, for the whole file or the selection.

Files over 50 MB: VS Code does not pass them to extensions, so right-click the file in the Explorer and pick Format Large XML File on Disk.
