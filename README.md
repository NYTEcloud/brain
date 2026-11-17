# B.R.A.I.N. V1 client packages

Shared memory for your AI bots. Every bot on your team adds notes and looks them up in a few milliseconds,
from any computer. This repo holds the source for the official B.R.A.I.N. V1 client libraries for Node.js
and Python, plus retrievers for LangChain and LlamaIndex.

Sign up and get your team key at https://brain.telonyte.com. Copy-paste examples live at
https://brain.telonyte.com/setup/api.

## Packages

| Folder | Registry | Install |
|---|---|---|
| `npm-telonyte-brain` | [@telonyte/brain](https://www.npmjs.com/package/@telonyte/brain) | `npm install @telonyte/brain` |
| `npm-telonyte-brain-langchain` | [@telonyte/brain-langchain](https://www.npmjs.com/package/@telonyte/brain-langchain) | `npm install @telonyte/brain-langchain @langchain/core` |
| `npm-telonyte-brain-llamaindex` | [@telonyte/brain-llamaindex](https://www.npmjs.com/package/@telonyte/brain-llamaindex) | `npm install @telonyte/brain-llamaindex @llamaindex/core` |
| `pip-telonyte-brain` | [telonyte-brain](https://pypi.org/project/telonyte-brain/) | `pip install telonyte-brain` |
| `pip-telonyte-brain-langchain` | [telonyte-brain-langchain](https://pypi.org/project/telonyte-brain-langchain/) | `pip install telonyte-brain-langchain` |
| `pip-telonyte-brain-llamaindex` | [telonyte-brain-llamaindex](https://pypi.org/project/telonyte-brain-llamaindex/) | `pip install telonyte-brain-llamaindex` |

## Quick start

```js
import { add, find } from "@telonyte/brain";
await add("my-bot", "NEW | The staging deploy runs on Fridays | team notes");
const { lines } = await find("staging deploy");
```

```python
from telonyte_brain import add, find
add("my-bot", "NEW | The staging deploy runs on Fridays | team notes")
print("\n".join(find("staging deploy")["lines"]))
```

Set `BRAIN_KEY` to your bot's key. `BRAIN_URL` is optional and defaults to `https://brain.telonyte.com`.

## Why it's fast

There's no model on the lookup path. Long-running programs keep an encrypted copy of your team's memory on
the machine and answer from it (we call it Hyper speed), and the host answers whenever that copy is missing
or behind. Each package README has the details.

## Running the tests

```
cd npm-telonyte-brain && npm test
cd pip-telonyte-brain && python -m unittest discover -s tests
```

## License

Copyright Telonyte LLC. All rights reserved. You may install and use the published packages with a
B.R.A.I.N. V1 account. See https://brain.telonyte.com/terms.
