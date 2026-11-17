class QueryBundle:
    def __init__(self, query_str):
        self.query_str = query_str


class TextNode:
    def __init__(self, text="", metadata=None):
        self.text, self.metadata = text, dict(metadata or {})

    def get_content(self):
        return self.text


class NodeWithScore:
    def __init__(self, node, score=None):
        self.node, self.score = node, score
