'use strict';
// REACH1 (lane NEWSHIP): this listing's Pro tools for the toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  "prefix": "xmlXpathTools",
  "triesKey": "xmlXpathTools.proTrial",
  "slot": "",
  "tools": [
    {
      "id": "xpathFolder",
      "title": "Run XPath on Every XML File in a Folder",
      "command": "xmlXpathTools.xpathFolder",
      "folderMenu": true
    },
    {
      "id": "formatFolder",
      "title": "Format All XML Files in a Folder",
      "command": "xmlXpathTools.formatFolder",
      "folderMenu": true
    },
    {
      "id": "compare",
      "title": "Compare Two XML Files Ignoring Formatting",
      "command": "xmlXpathTools.compareIgnoringFormat"
    }
  ]
};
