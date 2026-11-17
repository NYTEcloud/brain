from .schema import QueryBundle


class BaseRetriever:
    def __init__(self):
        pass

    def retrieve(self, query):
        return self._retrieve(query if isinstance(query, QueryBundle) else QueryBundle(query))
