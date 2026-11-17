# telonyte-brain

Python client for the B.R.A.I.N. V1 HTTP API. Standard library only, Python 3.9 or newer.

```python
from telonyte_brain import add, find
add("my-bot", "NEW | The staging deploy runs on Fridays | team notes")
print("\n".join(find("staging deploy")["lines"]))
```

Set `BRAIN_KEY` and optionally `BRAIN_URL`. See the copy-paste examples on https://brain.telonyte.com/setup/api.

Module functions: `status()`, `add(bot, text)`, `find(q, n=5)`, `delete(uid)`, `hyper()`, `close()`.
For more than one key, or to choose where the local copy lives, use a client:

```python
from telonyte_brain import Client
brain = Client(url=None, key=None, local=True, cache_dir=None, bot=None)
brain.find("staging deploy")
brain.hyper()["text"]   # "Hyper speed: on (local copy, synced 4s ago)"
brain.close()
```

## Hyper speed

The first time you look something up, the package starts keeping a private copy of your team's memory on this
computer and keeps it up to date in the background. After that, lookups are answered from that copy, in a few
milliseconds, with the same results the host would give. Notes added from any computer show up here within a few
seconds. If the copy cannot answer, the host does, so a lookup always works.

Every `find` answer carries `mode` (`local` or `host`) and `reason`, plus `synced_ago_s` when it came from the copy.
`hyper()` returns `{mode, reason, synced_ago_s, text}`, for example:

- `Hyper speed: on (local copy, synced 4s ago)`
- `Hyper speed: on (local copy, offline)`
- `Hyper speed: off (using host: no local copy yet)`
- `Hyper speed: off (using host: serverless or short-lived machine)`

If you already run the `brain` command line tool with the same URL and key, its background helper answers instead,
so nothing is kept twice.

The copy is stored in `telonyte-brain/<id>/` under your cache folder (`~/.cache`, or `%LOCALAPPDATA%` on Windows),
readable only by you, and encrypted at rest. It is removed if the key is revoked or the team is suspended, and it
locks if the computer stays offline past the license window.

**Meaning search.** In the background the package also sets up the same optional local search model as the `brain`
command line tool (a small model, bge-small, run in a private Python environment under the same cache folder; it
needs numpy, onnxruntime and tokenizers, so the first setup downloads about 100 MB and runs once, even when several
processes share the folder). Your notes stay on this computer. Until it is ready, and whenever it cannot answer in
time, lookups use the built-in engine, so setup never slows or blocks a lookup. Answers can differ from the host's;
the host stays the source of truth. Turn it off with `BRAIN_EMBED=0` or by creating an empty file named `off` in
`<copy folder>/embed/`.

**Turn it off.** Pass `local=False` to `Client`, or set `BRAIN_LOCAL=0`. Every call then goes to the host, as in
earlier versions, and no folder is created.

**Serverless and short-lived machines.** On AWS Lambda, Vercel, Netlify, Google Cloud Functions and Run, Azure
Functions and Deno Deploy the package detects it and uses the host, because a copy would be gone at the next start.
The same happens when the cache folder cannot be written or this Python has no `sqlite3` with FTS5. The local path
never raises: any problem sends the question to the host.

**Writes.** `add` goes to the host. If the host cannot be reached, the note is saved in a small outbox on this
computer, shows up in local lookups right away, and is sent later. Each note carries an id, so a resend never makes
a second copy.

Background work runs in daemon threads that never keep your program alive. `close()` stops them; it also runs
when the program exits.
