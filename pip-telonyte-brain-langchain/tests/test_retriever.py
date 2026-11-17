import unittest
from unittest import mock

from telonyte_brain_langchain import BrainRetriever


class BrainRetrieverTest(unittest.TestCase):
    def setUp(self):
        self.retriever = BrainRetriever(bot="support", k=3)

    def test_fields(self):
        self.assertEqual((self.retriever.bot, self.retriever.k), ("support", 3))
        self.assertEqual(BrainRetriever(bot="b").k, 5)

    def test_invoke_maps_strings_and_dicts(self):
        lines = ["plain note", {"text": "dict note", "uid": "u1", "score": 0.5}, {"text": "bare"}]
        with mock.patch("telonyte_brain.find", return_value={"lines": lines}) as find:
            docs = self.retriever.invoke("hours")
        find.assert_called_once_with("hours", n=3)
        self.assertEqual([d.page_content for d in docs], ["plain note", "dict note", "bare"])
        self.assertEqual(docs[0].metadata, {})
        self.assertEqual(docs[1].metadata, {"uid": "u1", "score": 0.5})
        self.assertEqual(docs[2].metadata, {})

    def test_invoke_empty(self):
        with mock.patch("telonyte_brain.find", return_value={"lines": []}):
            self.assertEqual(self.retriever.invoke("x"), [])
        with mock.patch("telonyte_brain.find", return_value={}):
            self.assertEqual(self.retriever.invoke("x"), [])

    def test_add_and_delete(self):
        with mock.patch("telonyte_brain.add", return_value={"uid": "u9"}) as add:
            self.assertEqual(self.retriever.add("a note"), {"uid": "u9"})
        add.assert_called_once_with("support", "a note")
        with mock.patch("telonyte_brain.delete", return_value={"ok": True}) as delete:
            self.assertEqual(self.retriever.delete("u9"), {"ok": True})
        delete.assert_called_once_with("u9")


if __name__ == "__main__":
    unittest.main()
