# Codex Little Home

Codex Little Home is a private, interactive 3D workroom for a locally signed-in
Codex CLI. It adapts the original room's walkable interior, camera controls,
lighting and desktop display into a phone-friendly Codex task surface.

## Architecture

```
browser -> nginx Basic Auth -> local Node service -> codex app-server (stdio)
```

The public listener is nginx. The Node service binds to `127.0.0.1:23180`, and
the Codex app-server runs as its child over stdio. The browser never receives a
Codex token, local CLI socket, or arbitrary shell endpoint.

## Run locally

```bash
npm run check
npm test
npm start
```

Open `http://127.0.0.1:23180/`. The service only accepts tasks for the one
workspace configured by `CODEX_HOME_WORKSPACE`; it does not accept a path from
the browser. Codex receives `workspace-write` sandboxing with network access
disabled and automatic approvals disabled.

## Deploy

The repository includes ready-to-copy service and nginx files in `deploy/`.
Install the systemd unit, create a Basic Auth password file, include the nginx
locations in the existing `landisha.icu` HTTP and HTTPS server blocks, validate
nginx, then start the service. The intended public URL is:

`https://landisha.icu/codex/`

Keep the service private. Do not proxy a raw `codex app-server` WebSocket to the
internet and do not commit `.env`, task history, or Codex login state.

## Attribution

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The visual room is new CSS
art; this repository contains none of the original template's restricted models
or character assets.
