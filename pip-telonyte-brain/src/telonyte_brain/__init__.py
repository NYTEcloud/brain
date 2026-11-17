"""B.R.A.I.N. V1 client for Python. Reads BRAIN_URL and BRAIN_KEY from the environment.

Module level: status(), add(bot, text), find(q, n=5), delete(uid), hyper(), close().
Client(url=None, key=None, local=True, cache_dir=None, bot=None) has the same methods for more than one key.
"""
from ._client import Client, __version__, add, close, delete, find, hyper, hyper_text, status

__all__ = ["Client", "status", "add", "find", "delete", "hyper", "close", "hyper_text", "__version__"]
