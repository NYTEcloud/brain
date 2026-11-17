"""LangChain retriever adapter for B.R.A.I.N. V1."""
from __future__ import annotations

from typing import Any, List, Optional

import telonyte_brain
from langchain_core.callbacks import CallbackManagerForRetrieverRun
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever

__all__ = ["BrainRetriever"]
__version__ = "0.2.0"


def _to_document(line: Any) -> Document:
    """A line is a string, or a dict with text and maybe uid and score."""
    if not isinstance(line, dict):
        return Document(page_content=str(line))
    metadata = {key: line[key] for key in ("uid", "score") if line.get(key) is not None}
    return Document(page_content=str(line.get("text", "")), metadata=metadata)


class BrainRetriever(BaseRetriever):
    """Retrieve notes for one bot from B.R.A.I.N. V1. Call invoke(query).

    After each call, last_mode is "local" (answered from the local copy) or "host", and last_reason says why.
    """

    bot: str
    k: int = 5
    last_mode: Optional[str] = None
    last_reason: Optional[str] = None

    def _get_relevant_documents(
        self, query: str, *, run_manager: CallbackManagerForRetrieverRun
    ) -> List[Document]:
        result = telonyte_brain.find(query, n=self.k)
        self.last_mode = (result or {}).get("mode")
        self.last_reason = (result or {}).get("reason")
        return [_to_document(line) for line in (result or {}).get("lines") or []]

    def add(self, text: str) -> dict:
        return telonyte_brain.add(self.bot, text)

    def delete(self, uid: str) -> dict:
        return telonyte_brain.delete(uid)
