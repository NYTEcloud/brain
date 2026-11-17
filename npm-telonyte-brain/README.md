# @telonyte/brain

Node.js client for B.R.A.I.N. V1.

```js
import { add, find } from "@telonyte/brain";
await add("my-bot", "NEW | The staging deploy runs on Fridays | team notes");
const { lines, mode, reason } = await find("staging deploy");
```

Set `BRAIN_KEY` and optionally `BRAIN_URL`. See the copy-paste examples on https://brain.telonyte.com/setup/api.

For your own settings, make a client:

```js
import { createClient } from "@telonyte/brain";
const brain = createClient({ url, key, local: true, cacheDir, bot: "my-bot" });
await brain.find("staging deploy", 5);
console.log(brain.hyper().text); // Hyper speed: on (local copy, synced 4s ago)
brain.close();
```

`status()`, `add(bot, text)`, `find(q, n)` and `remove(uid)` work the same on the module and on a client.
Every answer keeps the fields it always had and adds `mode` and `reason`.

## Hyper speed

When your program keeps running, the package keeps a copy of your team's memory on your machine and
answers lookups from it. The copy stays in sync with the host: a note added by any bot on any computer
shows up within a few seconds. If the copy is missing, still building or behind, the host answers, so
you always get an answer.

- `mode` is `local` when the answer came from the copy on your machine, `host` when it came from the host.
- `reason` says why, for example `synced`, `no_copy_yet`, `rebuilding`, `stale` or `serverless`.
- `hyper()` returns `{ mode, reason, synced_ago_s, text }` in plain words.
- If you also run the `brain` command line tool with its background helper, the package uses that copy.
- If the host cannot be reached, the copy keeps answering for up to 24 hours. Notes you add meanwhile wait
  in a small outbox and are sent later, once each.
- If the key is revoked or the team is suspended, the copy is deleted from the disk.
- The copy is stored under your cache folder in `telonyte-brain/`, readable only by your user, and
  encrypted at rest. It has no export command.

Turn it off with `createClient({ local: false })` or the environment variable `BRAIN_LOCAL=0`. Then every
lookup goes to the host, as before.

Serverless and short-lived machines (AWS Lambda, Vercel, Netlify, Cloud Run and similar, Deno Deploy,
Cloudflare Workers) skip the local copy automatically, because a fresh machine would start with no copy.
A disk you cannot write to does the same. Both report `mode: "host"`.

The local copy needs Node.js 22.13 or newer. Older versions work as before and report `old_runtime`.
A script that starts, asks one question and exits will mostly be answered by the host, since the copy is
built in the background while the program runs. Use one long-lived client, or the `brain` command line
helper, to get the local speed.
