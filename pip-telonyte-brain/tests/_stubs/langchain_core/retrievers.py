class BaseRetriever:
    """Fields come from class annotations with defaults, set from keyword arguments, like a pydantic model."""

    def __init__(self, **kw):
        names = {}
        for klass in reversed(type(self).__mro__):
            names.update(getattr(klass, "__annotations__", {}))
        for n in names:
            if n in kw:
                setattr(self, n, kw[n])
            elif not hasattr(type(self), n):
                raise TypeError("missing field " + n)

    def invoke(self, query):
        return self._get_relevant_documents(query, run_manager=None)
