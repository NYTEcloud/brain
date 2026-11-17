"""B.R.A.I.N. V1 client for Python: HTTP API plus an optional local synced copy ("Hyper speed").

Find order: a running `brain` daemon for the same URL and key, then this process's own local copy, then the host.
Every answer says which one it came from (`mode`, `reason`). The local path never raises: any problem sends the
question to the host. Standard library only.
"""
from __future__ import annotations

import atexit
import email.message
import hashlib
import http.client
import io
import json
import os
import pathlib
import secrets
import socket
import threading
import time
import urllib.error
import weakref
from urllib.parse import urlparse

from . import _local

__version__ = "2.2.6"
UA = "telonyte-brain-py/" + __version__
DEFAULT_URL = "https://brain.telonyte.com"

SERVERLESS_ENV = ("AWS_LAMBDA_FUNCTION_NAME", "LAMBDA_TASK_ROOT", "VERCEL", "NETLIFY", "K_SERVICE", "FUNCTION_TARGET",
                  "FUNCTIONS_WORKER_RUNTIME", "DENO_DEPLOYMENT_ID")

OFF_TEXT = {
    "no_copy_yet": "no local copy yet",
    "rebuilding": "local copy is rebuilding",
    "stale": "local copy is catching up",
    "lease_expired": "offline too long so the local copy is locked",
    "serverless": "serverless or short-lived machine",
    "opted_out": "local copy turned off",
    "no_storage": "this machine cannot store a local copy",
    "engine_update": "waiting for a client update",
    "old_runtime": "this Python needs sqlite3 with FTS5 for the local copy",
    "host_needed": "this question needs the host",
    "unknown": "reason unknown",
}

_LOCAL_KEYS = ("lines", "ms", "bytes", "path", "pack_tier", "instant")


def hyper_text(mode, reason, synced_ago_s=None):
    if mode == "local":
        if reason == "offline":
            return "Hyper speed: on (local copy, offline)"
        if synced_ago_s is None:
            return "Hyper speed: on (local copy)"
        return "Hyper speed: on (local copy, synced %ds ago)" % synced_ago_s
    return "Hyper speed: off (using host: %s)" % OFF_TEXT.get(reason, OFF_TEXT["unknown"])


def _env_off(name):
    return os.environ.get(name, "1").strip().lower() in ("0", "false", "no", "off")


def _cfg_id(url, key):
    return hashlib.sha256(("%s\n%s" % (url, key)).encode("utf-8")).hexdigest()[:16]


def _cache_base(explicit):
    if explicit:
        return pathlib.Path(explicit)
    if os.name == "nt":
        root = os.environ.get("LOCALAPPDATA") or str(pathlib.Path.home())
    else:
        root = os.environ.get("XDG_CACHE_HOME") or str(pathlib.Path.home() / ".cache")
    return pathlib.Path(root) / "telonyte-brain"


class _Http:
    """HTTPS with one kept-alive connection per thread. Every request names the package and reports Hyper speed."""

    def __init__(self, base, key, hyper):
        u = urlparse(base)
        self.tls = u.scheme == "https"
        self.host = u.hostname
        self.port = u.port or (443 if self.tls else 80)
        self.prefix = u.path.rstrip("/") if u.path and u.path != "/" else ""
        self.key, self.hyper, self.tl = key, hyper, threading.local()

    def _drop(self):
        c = getattr(self.tl, "c", None)
        self.tl.c = None
        if c is not None:
            try:
                c.close()
            except Exception:
                pass

    def request(self, method, path, body=None, hyper=None, timeout=30.0):
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Authorization": "Bearer " + self.key, "User-Agent": UA, "Accept": "application/json",
                   "X-Brain-Hyper": hyper or self.hyper()}
        if data is not None:
            headers["Content-Type"] = "application/json"
        for attempt in (0, 1):
            reused = getattr(self.tl, "c", None) is not None
            if not reused:
                cls = http.client.HTTPSConnection if self.tls else http.client.HTTPConnection
                self.tl.c = cls(self.host, self.port, timeout=timeout)
            try:
                self.tl.c.request(method, self.prefix + path, body=data, headers=headers)
                r = self.tl.c.getresponse()
                raw = r.read()
                break
            except socket.timeout:
                self._drop()
                raise
            except (OSError, http.client.HTTPException):
                self._drop()
                if attempt == 0 and reused:  # the host closed an idle connection: one retry on a fresh one
                    continue
                raise
        text = raw.decode("utf-8", "replace")
        if "json" in (r.getheader("content-type") or ""):
            try:
                return r.status, json.loads(text or "null")
            except ValueError:
                pass
        return r.status, text


_LIVE = weakref.WeakSet()


def _close_all():
    for c in list(_LIVE):
        try:
            c.close()
        except Exception:
            pass


atexit.register(_close_all)


class Client:
    """Client(url=None, key=None, local=True, cache_dir=None, bot=None)

    url, key   default to BRAIN_URL (https://brain.telonyte.com) and BRAIN_KEY.
    local      False (or BRAIN_LOCAL=0) turns the local copy off: every call goes to the host.
    cache_dir  where the local copy lives: <cache_dir>/<id of url+key>/. Default: <cache>/telonyte-brain/<id>/.
    bot        default bot name for find and add.
    """

    def __init__(self, url=None, key=None, local=True, cache_dir=None, bot=None):
        self.url = (url or os.environ.get("BRAIN_URL") or DEFAULT_URL).rstrip("/")
        self.key = key or os.environ.get("BRAIN_KEY")
        if not self.key:
            raise RuntimeError("Set BRAIN_KEY")
        self.bot = bot
        self.cfg_id = _cfg_id(self.url, self.key)
        self.cache_dir = _cache_base(cache_dir) / self.cfg_id
        self._opted_out = (not local) or _env_off("BRAIN_LOCAL")
        self._serverless = any(os.environ.get(v) for v in SERVERLESS_ENV)
        self._static = None  # a reason that rules the local copy out for good
        if not _local.has_sqlite():
            self._static = "no_storage"
        elif not _local.has_fts5():
            self._static = "old_runtime"
        self._http = _Http(self.url, self.key, self._hyper_header)
        self._lock = threading.RLock()
        self._local = None
        self._started = False
        self._pid = os.getpid()
        self._tenant_id = None
        self._last = None  # (mode, reason, synced_ago_s, time) of the last find that a CLI daemon answered
        _LIVE.add(self)

    # ---- Hyper speed state -------------------------------------------------------------------------------
    def _eligible(self):
        return not (self._opted_out or self._serverless or self._static)

    def _decide(self):
        """(mode, reason, synced_ago_s) for a find made right now. No network."""
        try:
            if self._opted_out:
                return "host", "opted_out", None
            if self._serverless:
                return "host", "serverless", None
            if self._static:
                return "host", self._static, None
            L = self._local
            if L is None:
                return "host", "no_copy_yet", None
            d, m = L.d, L.m
            if d.revoked:
                return "host", "no_copy_yet", None
            if not d.engine_ok or (L.cdir / "engine.mismatch").exists():
                return "host", "engine_update", None
            rep = d.rep
            if rep.ready:
                L.had_copy = True
            if not rep.ready or d.need_rebuild:
                return "host", ("rebuilding" if (L.had_copy or d.rebuilding) else "no_copy_yet"), None
            age = max(0, int((m._now_ms() - d.last_ok_ms) / 1000))
            if d.fresh():
                return "local", "synced", age
            if L.net_down:
                if m.lease_valid():
                    return "local", "offline", age
                return "host", "lease_expired", None
            return "host", "stale", None
        except Exception:
            return "host", "unknown", None

    def _hyper_header(self):
        mode, reason, _ = self._decide()
        return "%s;%s" % (mode, reason)

    def hyper(self):
        """{mode, reason, synced_ago_s, text}: is the local copy answering, and if not, why."""
        self._ensure_started()
        last = self._last
        if last and time.time() - last[3] < 30:
            mode, reason, age = last[0], last[1], last[2]
        else:
            mode, reason, age = self._decide()
        return {"mode": mode, "reason": reason, "synced_ago_s": age if mode == "local" else None,
                "text": hyper_text(mode, reason, age if mode == "local" else None)}

    # ---- local runtime -----------------------------------------------------------------------------------
    def _ensure_started(self):
        if not self._eligible():
            return
        if not self._started and self._cli_daemon_matches():
            return  # the CLI daemon already keeps the copy for this key: no second sync from this process
        with self._lock:
            if self._started and self._pid != os.getpid():  # forked: threads and sockets did not come along
                self._local, self._started = None, False
                self._http = _Http(self.url, self.key, self._hyper_header)
            if self._started:
                return
            self._started, self._pid = True, os.getpid()
            try:
                base = self.cache_dir.parent
                base.mkdir(parents=True, exist_ok=True)
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                for p in (base, self.cache_dir):
                    try:
                        os.chmod(str(p), 0o700)
                    except OSError:
                        pass
                probe = self.cache_dir / ("probe-%d.tmp" % os.getpid())
                probe.write_text("ok")
                probe.unlink()
            except Exception:
                self._static = "no_storage"
                return
            try:
                rt = _local.LocalRuntime(self.cache_dir, self.url, self.key, self._api, self._ws_lines)
                rt.start()
                self._local = rt
            except Exception:
                self._static = "unknown"

    def _api(self, method, path, cfg, body=None, timeout=30):
        """The vendored engine's HTTP hook: (status, parsed body); raises on a network failure."""
        return self._http.request(method, path, body, timeout=timeout)

    def _ws_lines(self):
        return "User-Agent: %s\r\nX-Brain-Hyper: %s" % (UA, self._hyper_header())

    def wait_ready(self, timeout=10.0):
        """Block until the local copy can answer (first sync done). False when it cannot (off, serverless, timeout)."""
        self._ensure_started()
        end = time.time() + timeout
        while time.time() < end:
            if self._decide()[0] == "local":
                return True
            if not self._eligible() or self._static:
                return False
            L = self._local
            if L is not None:
                L.d.kick_evt.set()
            time.sleep(0.05)
        return self._decide()[0] == "local"

    def close(self):
        """Stop the background sync. Safe to call twice; the Client then answers from the host only."""
        with self._lock:
            L, self._local = self._local, None
            self._started = True
            self._opted_out = True
        if L is not None and self._pid == os.getpid():
            L.stop()
        self._http._drop()  # this thread's kept-alive connection

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ---- host calls --------------------------------------------------------------------------------------
    def _call(self, method, path, body=None, hyper=None):
        """Like urllib: a non-2xx answer raises HTTPError. A refused key (401, 403) also wipes the local copy."""
        st, res = self._http.request(method, path, body, hyper=hyper)
        if st >= 400:
            L = self._local
            if st in (401, 403) and L is not None:
                try:
                    L.d._wipe(st, res if isinstance(res, dict) else {})
                except Exception:
                    pass
            raw = (json.dumps(res) if not isinstance(res, str) else res).encode("utf-8")
            msg = (res.get("error") if isinstance(res, dict) else str(res)) or "error"
            raise urllib.error.HTTPError(self.url + path, st, str(msg)[:200], email.message.Message(), io.BytesIO(raw))
        return res

    def _remember(self, res):
        if isinstance(res, dict) and res.get("tenant_id"):
            self._tenant_id = res["tenant_id"]

    # ---- public API --------------------------------------------------------------------------------------
    def status(self):
        self._ensure_started()
        mode, reason, age = self._decide()
        res = self._call("GET", "/v1/status", hyper="%s;%s" % (mode, reason))
        self._remember(res)
        if isinstance(res, dict):
            res = dict(res, mode=mode, reason=reason)
            if mode == "local":
                res["synced_ago_s"] = age
        return res

    def find(self, q, n=5, bot=None):
        bot = bot or self.bot
        q = str(q)
        got = self._cli_daemon_find(q, n, bot)
        if got is not None:
            return got
        self._ensure_started()
        mode, reason, age = self._decide()
        if mode == "local" and q.strip():
            res, why = self._local_find(q.strip(), n, bot, reason, age)
            if res is not None:
                return res
            reason = why
        elif mode == "local":
            reason = "host_needed"  # an empty question: the host's own error is the answer
        body = {"q": q, "n": n, "format": "json"}
        if bot:
            body["bot"] = bot
        res = self._call("POST", "/v1/find", body, hyper="host;" + reason)
        self._remember(res)
        if isinstance(res, dict):
            res = dict(res, mode="host", reason=reason)
        return res

    def add(self, bot, text):
        bot = bot or self.bot
        self._ensure_started()
        cid = secrets.token_urlsafe(16)
        try:
            res = self._call("POST", "/v1/add", {"bot": bot, "text": text, "cid": cid})
        except urllib.error.HTTPError:
            raise
        except (OSError, http.client.HTTPException):
            L = self._local
            if L is None or L.d.revoked or self._decide()[1] in ("opted_out", "serverless"):
                raise
            L.m._outbox_append(bot, text, cid)  # same cid on every replay: the host stores it once
            L.d.kick_evt.set()
            return {"ok": True, "queued": True, "cid": cid}
        L = self._local
        if L is not None and isinstance(res, dict):
            try:
                L.d.rep.insert_note(res.get("note"))
            except Exception:
                pass
        return res

    def delete(self, uid):
        self._ensure_started()
        res = self._call("POST", "/v1/delete", {"uid": uid})
        L = self._local
        if L is not None and isinstance(res, dict) and res.get("ok"):
            try:
                L.d.rep.forget(str(uid))
            except Exception:
                pass
        return res

    # ---- find paths --------------------------------------------------------------------------------------
    def _local_find(self, q, n, bot, reason, age):
        """-> (response, None), or (None, reason) when this question must go to the host. Never raises."""
        L = self._local
        try:
            d = L.d
            if not L.disk_present():
                d.need_rebuild = True  # file deleted or swapped under us: the host answers while the sync rebuilds
                d.kick_evt.set()
                return None, "rebuilding"
            r = d.rep.find(q, n, bot)
            res = dict((k, r[k]) for k in _LOCAL_KEYS if k in r)
            if self._tenant_id:
                res["tenant_id"] = self._tenant_id
            res.update(mode="local", reason=reason, synced_ago_s=age)
            return res, None
        except Exception:
            return None, "host_needed"

    def _cli_call(self, req):
        """One JSON line to the `brain` CLI daemon's socket and one back (its protocol). None when none answers."""
        try:
            cdir = _local.pristine().cache_dir()
            sock = cdir / "braind.sock"
            port = cdir / "braind.port"
            s = None
            try:
                if os.name != "nt" and hasattr(socket, "AF_UNIX") and sock.exists():
                    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    s.settimeout(0.05)
                    s.connect(str(sock))
                elif port.exists():
                    info = json.loads(port.read_text())
                    s = socket.create_connection(("127.0.0.1", int(info["port"])), 0.05)
                    req = dict(req, token=info["token"])
                else:
                    return None
                s.settimeout(10.0)
                s.sendall((json.dumps(req) + "\n").encode("utf-8"))
                buf = b""
                while b"\n" not in buf:
                    chunk = s.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
            finally:
                if s is not None:
                    s.close()
            r = json.loads(buf.split(b"\n", 1)[0].decode("utf-8", "replace")) if buf else None
            return r if isinstance(r, dict) else None
        except Exception:
            return None

    def _cli_daemon_matches(self):
        """Is a `brain` daemon for this team running? The 2.2.6 daemon accepts any verified key of the same team."""
        r = self._cli_call({"op": "find", "q": "", "cfg": self.cfg_id, "auth": self.key})
        return r is not None and not r.get("cfg_mismatch")

    def _cli_daemon_find(self, q, n, bot):
        """A running `brain` daemon for this team already holds a synced copy: ask it with this key."""
        if not self._eligible() or not q.strip():
            return None
        try:
            req = {"op": "find", "q": q.strip(), "n": n, "cfg": self.cfg_id, "auth": self.key}
            if bot:
                req["bot"] = bot
            r = self._cli_call(req)
            if r is None or not r.get("ok") or not isinstance(r.get("lines"), list):
                return None
            offline = bool(r.get("offline"))
            age = 0 if (r.get("ws") and not offline) else None
            reason = "offline" if offline else "synced"
            self._last = ("local", reason, age, time.time())
            res = dict((k, r[k]) for k in ("lines", "ms", "path") if k in r)
            if self._tenant_id:
                res["tenant_id"] = self._tenant_id
            res.update(mode="local", reason=reason, synced_ago_s=age)
            return res
        except Exception:
            return None


_default = {"c": None, "sig": None}
_default_lock = threading.Lock()


def _client():
    url = os.environ.get("BRAIN_URL", DEFAULT_URL).rstrip("/")
    key = os.environ.get("BRAIN_KEY")
    if not key:
        raise RuntimeError("Set BRAIN_KEY")
    sig = (url, key, _env_off("BRAIN_LOCAL"), os.environ.get("XDG_CACHE_HOME"), os.getpid())
    with _default_lock:
        if _default["sig"] != sig:
            old = _default["c"]
            if old is not None and _default["sig"][4] == os.getpid():
                old.close()
            _default["c"], _default["sig"] = Client(url=url, key=key), sig
        return _default["c"]


def status():
    return _client().status()


def add(bot, text):
    return _client().add(bot, text)


def find(q, n=5):
    return _client().find(q, n)


def delete(uid):
    return _client().delete(uid)


def hyper():
    return _client().hyper()


def close():
    with _default_lock:
        c, _default["c"], _default["sig"] = _default["c"], None, None
    if c is not None:
        c.close()
