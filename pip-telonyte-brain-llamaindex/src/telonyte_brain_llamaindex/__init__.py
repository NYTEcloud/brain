"""LlamaIndex retriever adapter for B.R.A.I.N. V1."""
from __future__ import annotations

from typing import Any, List, Optional

import telonyte_brain
from llama_index.core.retrievers import BaseRetriever
from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode

__all__ = ["BrainRetriever"]
__version__ = "0.2.0"


def _to_node(line: Any) -> NodeWithScore:
    """A line is a string, or a dict with text and maybe uid and score."""
    if not isinstance(line, dict):
        return NodeWithScore(node=TextNode(text=str(line)), score=None)
    metadata = {"uid": line["uid"]} if line.get("uid") is not None else {}
    node = TextNode(text=str(line.get("text", "")), metadata=metadata)
    return NodeWithScore(node=node, score=line.get("score"))


class BrainRetriever(BaseRetriever):
    """Retrieve notes for one bot from B.R.A.I.N. V1. Call retrieve(query).

    After each call, last_mode is "local" (answered from the local copy) or "host", and last_reason says why.
    """

    def __init__(self, bot: str, k: int = 5) -> None:
        self.bot = bot
        self.k = k
        self.last_mode: Optional[str] = None
        self.last_reason: Optional[str] = None
        super().__init__()

    def _retrieve(self, query_bundle: QueryBundle) -> List[NodeWithScore]:
        result = telonyte_brain.find(query_bundle.query_str, n=self.k)
        self.last_mode = (result or {}).get("mode")
        self.last_reason = (result or {}).get("reason")
        return [_to_node(line) for line in (result or {}).get("lines") or []]

    def add(self, text: str) -> dict:
        return telonyte_brain.add(self.bot, text)

    def delete(self, uid: str) -> dict:
        return telonyte_brain.delete(uid)
