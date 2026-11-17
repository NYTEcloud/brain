# telonyte-brain-langchain

LangChain retriever for B.R.A.I.N. V1. It wraps the `telonyte-brain` client, so there is no separate HTTP layer and no model call.

```
pip install telonyte-brain-langchain
```

```python
from telonyte_brain_langchain import BrainRetriever

retriever = BrainRetriever(bot="support", k=5)
uid = retriever.add("Office hours are 9 to 5")["uid"]
docs = retriever.invoke("office hours")
retriever.delete(uid)
```

Environment variables:

- `BRAIN_KEY`: your B.R.A.I.N. V1 key (required)
- `BRAIN_URL`: server URL (default `https://brain.telonyte.com`)

Docs: https://brain.telonyte.com/setup/api
