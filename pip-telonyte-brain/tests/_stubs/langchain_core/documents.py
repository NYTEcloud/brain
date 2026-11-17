class Document:
    def __init__(self, page_content="", metadata=None):
        self.page_content, self.metadata = page_content, dict(metadata or {})
