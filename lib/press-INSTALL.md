# Press week — wiring it into server.js

`lib/press.js` and `public/press.html` are already in place. server.js needs
three additions. It lives in the repo root, which was not shared with me, so
these are for you to paste.

## 1. Require the module

Next to the other `require`s at the top, after `const store = require("./lib/store");`

```js
const press = require("./lib/press");
```

## 2. The two API routes

In the request handler, immediately BEFORE this line:

```js
    if (p.startsWith("/api/")) return sendJSON(res, 404, { ok: false, message: "No such endpoint" });
```

insert:

```js
    if (p === "/api/press" && req.method === "GET") {
      return sendJSON(res, 200, press.read());
    }

    if (p === "/api/press" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req) || "{}");
      const result = press.save(body.rev, body.state);
      return sendJSON(res, result.ok ? 200 : 409,
        result.ok ? { rev: result.rev, updatedAt: result.updatedAt } : result.current);
    }
```

## 3. A tidy URL

On the last line of the handler, replace:

```js
    return serveStatic(req, res, p);
```

with:

```js
    if (p === "/press" || p === "/press/") return serveStatic(req, res, "/press.html");
    return serveStatic(req, res, p);
```

## That is all

No new dependencies, no render.yaml change, no new environment variables. The
page is served from `public/` like the rest of the app, sits behind the same
`DASHBOARD_PASS` gate, and the shared state is a single JSON document in the
same `/var/data` disk that already holds lead times, purchase orders and the
diary. It survives deploys for the same reason they do.

Local check before pushing:

    node --check lib/press.js
    node --check server.js
    node server.js          # then open http://localhost:3000/press

Live at `https://<your-render-url>/press`.

## What the page does

Everything on it saves for everyone: ticks, the "on it" name against each
block, a status and notes on every outreach contact, contacts the team adds,
and the coverage log. Writes carry the revision the browser last saw, so if
two people save at once the second is told and reloads rather than quietly
overwriting the first. Other tabs pick up changes within about twelve seconds.

If the network drops, edits keep working and sit in that browser's local
storage until it can save again. The pill in the header always says which
state it is in.
