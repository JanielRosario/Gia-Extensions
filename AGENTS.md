# Repository Ownership Guide

Read this before making changes in either GIA automation repository.

## Source of truth

- Tampermonkey userscripts belong in UGomez: https://github.com/ugomez809/GIA-TamperMonkey
- Browser extensions belong in JanielRosario: https://github.com/JanielRosario/Gia-Extensions

## Rules for agents

- Put `.user.js` Tampermonkey scripts, Tampermonkey updater scripts, and script support docs in the UGomez repository.
- Put Chrome/Edge extension manifests, service workers, content scripts, icons, deployment scripts, and extension docs in the JanielRosario repository.
- Do not add extension folders or extension deployment workflows to UGomez.
- Do not add Tampermonkey script folders to JanielRosario.
- Before editing update metadata, verify `@updateURL`, `@downloadURL`, GitHub API URLs, and raw GitHub URLs point to the correct source-of-truth repository.
- If a future change is found in the wrong repository, move the newest version into the correct repository before making additional edits.
