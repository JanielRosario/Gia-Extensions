# Installer Pages

Static GitHub Pages assets for Tampermonkey updater installation.

- `installer-config.json`: shared position and script-card configuration.
- `manager.html`: browser editor for saving installer config changes back to GitHub with a fine-grained token. The token can be remembered locally with the browser password manager or loaded from a local text file. Token files may contain only the token, the token on line 1 and commit message on line 2, or JSON with `token` and `commitMessage`.
