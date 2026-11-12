# Browse the XML tree

XML Tree in the Explorer shows the elements of the open file with their id or name and a short text preview. It follows the cursor, and a click selects the tag in the editor.

The tree is built in a background thread and opens one level at a time. Elements with more than 500 children open in groups of 500, so a file with 200,000 lines stays fast.

If the file has an error, the tree shows the part before it and the message names the line and column.
