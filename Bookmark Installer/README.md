# Bookmark Installer Manager

Static manager page and shared JSON config for the GWPC staff bookmark installer extension.

## Files

- `manager.html` lets a manager edit agency and position bookmark sets.
- `bookmarks-config.json` is the data file read by the installer extension.

## Manager flow

1. Open `manager.html` from GitHub Pages or from a local web server.
2. Select an agency and position.
3. Add bookmarks/folders manually or import Chrome/Edge bookmark export `.html` files.
4. Review the bookmarks bar preview and JSON output.
5. Save to GitHub with a fine-grained token for `JanielRosario/Gia-Extensions`.

The token needs only `Contents: Read and write` for this repository. Do not commit tokens.

## Data shape

Bookmarks are stored by agency and position. The installer creates this managed folder path on the browser bookmarks bar:

```text
GWPC Staff / Agency Name / Position Name
```

The installer is additive. It reuses existing folders, skips duplicate URLs, and does not delete manually created browser bookmarks.
