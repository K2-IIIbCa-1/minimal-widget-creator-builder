# Minimal Widget Creator Builder

Static client-only Builder. No server-side application is required for the Builder itself.

## Features

- Exact 200x40 preview plus 4x inspection preview.
- Four independent corner strings and colors.
- `{days}` may appear once in any corner.
- Generic live placeholders such as `{rank4}` and `{points4}` are baked with an ASCII runtime glyph atlas and filled by the Worker's live-data endpoint.
- Background URL / local preview image.
- Frame border/light/dark colors, text shadow, fallback background and dim control.
- Widget ID controls the deployed public file name (`/<id>.svg`).
- Direct create/update/load/delete against the user's deployed Worker using an admin token.

## Operator configuration

Before publishing the Builder, edit `app.js`:

```js
const TEMPLATE_REPO_URL = 'https://github.com/YOUR_NAME/minimal-widget-creator-worker';
```

Use the public repository that contains the contents of `worker-template/` at its root.

## Run locally

```bash
python -m http.server 8080 -d builder
```

Then open `http://localhost:8080`.
