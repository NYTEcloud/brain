"""Unit tests with a stub HTTP host (no wrangler, no network). Run: python3 -m unittest discover -s tests -v"""
import json, os, pathlib, re, subprocess, sys, tempfile, threading, unittest, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PKG = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PKG / "src"))
import telonyte_brain as tb  # noqa: E402
from telonyte_brain import _client, _local  # noqa: E402

REASONS = set(_client.OFF_TEXT) | {"synced", "offline"}
CLEAN = ("AWS_LAMBDA_FUNCTION_NAME", "LAMBDA_TASK_ROOT", "VERCEL", "NETLIFY", "K_SERVICE", "FUNCTION_TARGET",
         "FUNCTIONS_WORKER_RUNTIME", "DENO_DEPLOYMENT_ID", "BRAIN_LOCAL", "BRAIN_URL", "BRAIN_KEY", "BRAIN_CACHE")


class Stub:
    def __init__(self):
        self.seen = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _do(self):
                n = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(n).decode() if n else ""
                outer.seen.append({"m": self.command, "p": self.path, "h": dict((k.lower(), v) for k, v in self.headers.items()), "b": body})
                code, out = 200, {}
                if self.path == "/v1/find":
                    q = json.loads(body).get("q")
                    out = {"lines": ["hit for " + q, "(1ms)"], "ms": 1, "tenant_id": "t1"} if q != "boom" else {"error": "nope"}
                    code = 200 if q != "boom" else 400
                elif self.path == "/v1/status":
                    out = {"tenant_id": "t1", "notes": 3}
                elif self.path == "/v1/add":
                    out = {"ok": True, "uid": "u1", "ts": "now"}
                    code = 201
                elif self.path == "/v1/delete":
                    out = {"ok": True}
                elif self.path.startswith("/v1/sync"):
                    code = 500
                raw = json.dumps(out).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = _do

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def stop(self):
        self.srv.shutdown()


class Base(unittest.TestCase):
    def setUp(self):
        self.saved = dict((k, os.environ.pop(k, None)) for k in CLEAN)
        self.tmp = tempfile.mkdtemp(prefix="tb-unit-")
        self.stub = Stub()
        self.clients = []

    def tearDown(self):
        for c in self.clients:
            c.close()
        tb.close()
        self.stub.stop()
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def client(self, **kw):
        c = tb.Client(url=self.stub.url, key="k-test", cache_dir=self.tmp, **kw)
        self.clients.append(c)
        return c


class HyperText(unittest.TestCase):
    def test_texts(self):
        self.assertEqual(tb.hyper_text("local", "synced", 4), "Hyper speed: on (local copy, synced 4s ago)")
        self.assertEqual(tb.hyper_text("local", "offline", 9), "Hyper speed: on (local copy, offline)")
        self.assertEqual(tb.hyper_text("host", "no_copy_yet"), "Hyper speed: off (using host: no local copy yet)")
        self.assertEqual(tb.hyper_text("host", "serverless"), "Hyper speed: off (using host: serverless or short-lived machine)")
        self.assertEqual(tb.hyper_text("host", "zzz"), "Hyper speed: off (using host: reason unknown)")
        for r, t in _client.OFF_TEXT.items():
            self.assertNotIn("—", t)
            self.assertNotIn("–", t)

    def test_vendored_file_is_current(self):
        src = PKG.parent.parent / "client" / "brain.src.py"
        if not src.exists():
            self.skipTest("client/brain.src.py is not in this packages-only checkout")
        out = subprocess.run([sys.executable, str(PKG / "build_vendor.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        head = (PKG / "src/telonyte_brain/_vendor_client.py").read_text().split("\n", 3)
        self.assertTrue(re.match(r"# source-sha256: [0-9a-f]{64}$", head[1]))

    def test_engine_version_matches_server(self):
        ts_path = PKG.parent.parent / "src" / "tenant.ts"
        if not ts_path.exists():
            self.skipTest("src/tenant.ts is not in this packages-only checkout")
        ts = ts_path.read_text()
        want = re.search(r'FIND_ENGINE = "([^"]+)"', ts).group(1)
        self.assertEqual(_local.pristine().LOCAL_RANK_VERSION, want)

    def test_import_has_no_side_effects(self):
        home = tempfile.mkdtemp(prefix="tb-home-")
        code = "import sys; sys.path.insert(0, %r); import telonyte_brain, os; print(sorted(os.listdir(%r)))" % (str(PKG / "src"), home)
        env = dict(os.environ, HOME=home, XDG_CACHE_HOME=home + "/c", XDG_CONFIG_HOME=home + "/cfg", PYTHONDONTWRITEBYTECODE="1")
        out = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, env=env)
        self.assertEqual(out.stdout.strip(), "[]", out.stderr)


class Compat(Base):
    def test_module_functions_and_headers(self):
        os.environ.update(BRAIN_URL=self.stub.url, BRAIN_KEY="k-test", BRAIN_LOCAL="0")
        self.assertEqual(tb.status()["tenant_id"], "t1")
        r = tb.find("hello", 3)
        self.assertEqual(r["lines"][0], "hit for hello")
        self.assertEqual((r["mode"], r["reason"]), ("host", "opted_out"))
        a = tb.add("bot", "NEW | a fact | src")
        self.assertTrue(a["ok"])
        self.assertTrue(tb.delete("u1")["ok"])
        body = [json.loads(s["b"]) for s in self.stub.seen if s["p"] == "/v1/add"][0]
        self.assertEqual(sorted(body), ["bot", "cid", "text"])
        self.assertGreaterEqual(len(body["cid"]), 8)
        for s in self.stub.seen:
            self.assertEqual(s["h"]["user-agent"], "telonyte-brain-py/2.2.7")
            self.assertEqual(s["h"]["x-brain-hyper"], "host;opted_out")
            self.assertEqual(s["h"]["authorization"], "Bearer k-test")

    def test_errors_like_urllib(self):
        os.environ.update(BRAIN_URL=self.stub.url, BRAIN_KEY="k-test", BRAIN_LOCAL="0")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            tb.find("boom")
        self.assertEqual(cm.exception.code, 400)
        self.assertIn("nope", cm.exception.read().decode())
        del os.environ["BRAIN_KEY"]
        with self.assertRaisesRegex(RuntimeError, "Set BRAIN_KEY"):
            tb.find("x")

    def test_connection_failure_raises_when_local_is_off(self):
        c = tb.Client(url="http://127.0.0.1:9", key="k", local=False, cache_dir=self.tmp)
        self.clients.append(c)
        with self.assertRaises(OSError):
            c.add("bot", "NEW | x | y")
        with self.assertRaises(OSError):
            c.find("x")

    def test_hyper_report_on_every_request_and_ws_upgrade(self):
        c = self.client()
        c.find("one")  # local copy starts, its first sync (500) and websocket upgrade (404) run in threads
        c.wait_ready(1.0)
        deadline = __import__("time").time() + 5
        while __import__("time").time() < deadline and not any(s["p"].startswith("/v1/sync/ws") for s in self.stub.seen):
            __import__("time").sleep(0.05)
        paths = set(s["p"].split("?")[0] for s in self.stub.seen)
        self.assertIn("/v1/find", paths)
        self.assertIn("/v1/sync", paths)
        self.assertIn("/v1/sync/ws", paths)
        for s in self.stub.seen:
            self.assertEqual(s["h"]["user-agent"], "telonyte-brain-py/2.2.7", s["p"])
            mode, reason = s["h"]["x-brain-hyper"].split(";")
            self.assertIn(mode, ("local", "host"))
            self.assertIn(reason, REASONS, s["p"])
        h = c.hyper()
        self.assertEqual(h["mode"], "host")
        self.assertTrue(h["text"].startswith("Hyper speed: off (using host: "))
        self.assertEqual(set(h), {"mode", "reason", "synced_ago_s", "text"})


class Fallbacks(Base):
    def test_serverless_env(self):
        for var in _client.SERVERLESS_ENV:
            os.environ[var] = "1"
            try:
                c = self.client()
                r = c.find("q")
                self.assertEqual((r["mode"], r["reason"]), ("host", "serverless"), var)
                self.assertFalse(pathlib.Path(self.tmp, c.cfg_id).exists(), var)
                self.assertEqual(c.hyper()["reason"], "serverless")
            finally:
                del os.environ[var]

    def test_opt_out_argument_and_env(self):
        self.assertEqual(self.client(local=False).find("q")["reason"], "opted_out")
        os.environ["BRAIN_LOCAL"] = "0"
        self.assertEqual(self.client().find("q")["reason"], "opted_out")

    def test_no_storage(self):
        blocker = pathlib.Path(self.tmp, "afile")
        blocker.write_text("x")
        c = tb.Client(url=self.stub.url, key="k", cache_dir=blocker / "sub")
        self.clients.append(c)
        r = c.find("q")
        self.assertEqual((r["mode"], r["reason"]), ("host", "no_storage"))
        self.assertEqual(r["lines"][0], "hit for q")

    def test_read_only_dir(self):
        if os.getuid() == 0:
            self.skipTest("root ignores directory permissions")
        ro = pathlib.Path(self.tmp, "ro")
        ro.mkdir()
        ro.chmod(0o500)
        try:
            c = tb.Client(url=self.stub.url, key="k", cache_dir=ro)
            self.clients.append(c)
            self.assertEqual(c.find("q")["reason"], "no_storage")
        finally:
            ro.chmod(0o700)

    def test_no_sqlite_and_no_fts5(self):
        code = ("import sys; sys.modules['sqlite3'] = None; sys.path.insert(0, %r)\n"
                "import telonyte_brain as tb, json\n"
                "c = tb.Client(url=%r, key='k', cache_dir=%r)\n"
                "r = c.find('q'); print(json.dumps([r['mode'], r['reason'], r['lines'][0]]))\n") % (str(PKG / "src"), self.stub.url, self.tmp)
        out = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        self.assertEqual(json.loads(out.stdout), ["host", "no_storage", "hit for q"], out.stderr)
        _local._FTS5[:] = [False]
        try:
            self.assertEqual(self.client().find("q")["reason"], "old_runtime")
        finally:
            _local._FTS5[:] = []

    def test_local_path_never_raises_and_failed_sync_uses_host(self):
        c = self.client()
        r = c.find("q")
        self.assertEqual(r["lines"][0], "hit for q")
        self.assertEqual(r["mode"], "host")
        self.assertIn(r["reason"], ("no_copy_yet", "rebuilding", "stale"))
        c.close()
        self.assertEqual(c.find("q")["mode"], "host")
        c.close()


class EmbedDefault(Base):
    """The package daemon runs the local search model like the CLI daemon: on by default, BRAIN_EMBED=0 or the off file turn it off."""

    def engine_name(self):
        rt = _local.LocalRuntime(self.tmp, self.stub.url, "k-test", None, [])
        try:
            self.assertTrue(rt.d.rep.allow_embed)
            return type(rt.m.make_engine(rt.d.rep.allow_embed)).__name__
        finally:
            rt.d.rep.close()

    def test_embed_on_by_default(self):
        saved = dict((k, os.environ.pop(k, None)) for k in ("BRAIN_EMBED", "BRAIN_LOCAL_ENGINE"))
        try:
            self.assertEqual(self.engine_name(), "EmbedEngine")
            os.environ["BRAIN_EMBED"] = "0"
            self.assertEqual(self.engine_name(), "HostedEngine")
            del os.environ["BRAIN_EMBED"]
            (pathlib.Path(self.tmp) / "embed").mkdir()
            (pathlib.Path(self.tmp) / "embed" / "off").write_text("")
            self.assertEqual(self.engine_name(), "HostedEngine")
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


if __name__ == "__main__":
    unittest.main()
