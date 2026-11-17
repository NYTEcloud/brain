# @telonyte/brain-llamaindex

LlamaIndex retriever for B.R.A.I.N. V1. It wraps the `@telonyte/brain` client, so there is no separate HTTP layer and no model call.

```
npm install @telonyte/brain-llamaindex @llamaindex/core
```

```js
import { BrainRetriever } from "@telonyte/brain-llamaindex";

const retriever = new BrainRetriever({ bot: "support", k: 5 });
const { uid } = await retriever.add("Office hours are 9 to 5");
const nodes = await retriever.retrieve({ query: "office hours" });
await retriever.delete(uid);
```

Environment variables:

- `BRAIN_KEY`: your B.R.A.I.N. V1 key (required)
- `BRAIN_URL`: server URL (default `https://brain.telonyte.com`)

Docs: https://brain.telonyte.com/setup/api
