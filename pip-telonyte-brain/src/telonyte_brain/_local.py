"""The in-process local copy: one private instance of the vendored `brain` client engine per Client.

The vendored module (_vendor_client.py, generated from client/brain.src.py) keeps its paths and settings in module
globals. Each Client loads its own instance of it and points those globals at its own folder, so two Clients
(or a Client and the `brain` CLI) never share state by accident. Nothing here runs at import time.
"""
from __future__ import annotations

import importlib.util
import os
import pathlib
import threading

_FILES = (
    ("OUT", "outbox.jsonl"), ("REC", "recent-results.json"), ("STATE", "update-state.json"), ("ERRLOG", "errors.jsonl"),
    ("AUTO_LOG", "update-auto.log"), ("SWR", "swr-cache.json"), ("LEASE_FILE", "lease.json"), ("ENC_SWR", "swr-cache.enc"),
    ("DAEMON_LOG", "braind.log"), ("DAEMON_SOCK", "braind.sock"), ("DAEMON_PORT", "braind.port"),
    ("DAEMON_PID", "braind.pid"), ("DAEMON_SPAWN", "braind.spawn"), ("REJECTED", "outbox-rejected.jsonl"),
)

_FTS5 = []


def has_sqlite():
    try:
        import sqlite3  # noqa: F401
        return True
    except ImportError:
        return False


def has_fts5():
    """The local engine ranks with SQLite FTS5 as well as its own index; a Python build without it uses the host."""
    if not _FTS5:
        ok = False
        try:
            import sqlite3
            db = sqlite3.connect(":memory:")
            try:
                db.execute("CREATE VIRTUAL TABLE t USING fts5(a)")
                ok = True
            finally:
                db.close()
        except Exception:
            ok = False
        _FTS5.append(ok)
    return _FTS5[0]


def vendor_path():
    from . import _vendor_client
    return pathlib.Path(_vendor_client.__file__)


def pristine():
    """The shared, untouched vendored module: only for its pure helpers (cache_dir, cfg_id)."""
    from . import _vendor_client
    return _vendor_client


def _load_instance():
    path = vendor_path()
    spec = importlib.util.spec_from_file_location("telonyte_brain._vendor_instance", str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, path


def _daemon_class(m):
    class PkgDaemon(m.Daemon):
        """The CLI's sync daemon without its socket: heartbeat, change pings, rebuilds and outbox pushes, in threads.
        Two changes: several processes may share one folder (rebuilds take a file lock and adopt a copy another
        process just built), and the runtime remembers whether the host could be reached. Like the CLI daemon it
        runs the local search model (bge-small hybrid) in the background unless BRAIN_EMBED=0 or <folder>/embed/off:
        the vendored engine installs it once (file lock in the shared folder), each process may run its own worker,
        and until it is ready, or on any fault or slow answer, finds use the built-in engine."""

        def __init__(self, owner):
            m.Daemon.__init__(self)
            self.owner = owner
            self.rep.allow_embed = True  # the Daemon default, stated here because the package once forced it off

        def sync_cycle(self):
            try:
                m.Daemon.sync_cycle(self)
                self.owner.net_down = False
            except (m._SyncNet, m._SyncFail):
                self.owner.net_down = True
                raise

        def _rebuild(self, cfg, why):
            lock = m._FileLock(self.dir / "rebuild.lock", stale=120)
            if not lock.acquire(10.0):
                raise m._SyncFail("another process is rebuilding the local copy")
            try:
                try:
                    cur = os.stat(str(self.rep.db_path)).st_ino
                except OSError:
                    cur = None
                if cur is not None and cur != self.rep.db_ino and self.rep.load():
                    # another process swapped in a fresh copy: use it; the next sync checks it against the host
                    self.need_rebuild = False
                    self.last_ok_ms = self.rep.stamp["last_ok_ms"]
                    return
                m.Daemon._rebuild(self, cfg, why)
            finally:
                lock.release()

        def sync_loop(self):
            if not self.rep.ready:
                self.startup_check()
            while not self.stop_evt.is_set():
                try:
                    self.sync_cycle()
                except m._SyncStop:
                    break
                except Exception as e:
                    m._dlog("sync cycle: %s %s" % (type(e).__name__, e))
                if self.stop_evt.is_set():
                    break
                polling = (not self.ws_up) and self.ws_fails >= 3
                self.kick_evt.wait(m.POLL_S if polling else m.HEARTBEAT_S)
                self.kick_evt.clear()
            self.stop_evt.set()

    return PkgDaemon


class LocalRuntime:
    def __init__(self, cdir, url, key, api, ws_lines):
        self.cdir = pathlib.Path(cdir)
        self.net_down = False
        self.had_copy = False
        self.threads = []
        self.m, vpath = _load_instance()
        m, c = self.m, self.cdir
        m.C = c
        for name, fname in _FILES:
            setattr(m, name, c / fname)
        m.cache_dir = lambda: c
        m.load_cfg = lambda: {"url": url, "key": key}
        m.self_path = lambda: vpath
        m.api = api
        m._ws_ua_lines = ws_lines
        m._QUIET[0] = True
        self.had_copy = (c / "replica.db").exists()
        self.d = _daemon_class(m)(self)

    def start(self):
        d = self.d
        try:
            d.startup_check()
        except Exception:
            pass
        for target, name in ((d.sync_loop, "telonyte-brain-sync"), (d.ws_loop, "telonyte-brain-ws")):
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self.threads.append(t)

    def stop(self):
        d = self.d
        d.stop_evt.set()
        d.kick_evt.set()
        for t in self.threads:
            t.join(0.5)  # daemon threads: one stuck in a slow connect is left to die with the process
        try:
            d.rep.close()
        except Exception:
            pass

    def disk_present(self):
        """Is replica.db still the file this process loaded? A deleted or swapped file sends finds to the host at once."""
        rep = self.d.rep
        try:
            return not rep.db_ino or os.stat(str(rep.db_path)).st_ino == rep.db_ino
        except OSError:
            return False
