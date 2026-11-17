import unittest
from unittest import mock

from telonyte_brain_llamaindex import BrainRetriever


class BrainRetrieverTest(unittest.TestCase):
    def setUp(self):
        self.retriever = BrainRetriever(bot="support", k=3)

    def test_fields(self):
        self.assertEqual((self.retriever.bot, self.retriever.k), ("support", 3))
        self.assertEqual(BrainRetriever("b").k, 5)

    def test_retrieve_maps_strings_and_dicts(self):
        lines = ["plain note", {"text": "dict note", "uid": "u1", "score": 0.5}, {"text": "bare"}]
        with mock.patch("telonyte_brain.find", return_value={"lines": lines}) as find:
            nodes = self.retriever.retrieve("hours")
        find.assert_called_once_with("hours", n=3)
        self.assertEqual([n.node.get_content() for n in nodes], ["plain note", "dict note", "bare"])
        self.assertEqual([n.score for n in nodes], [None, 0.5, None])
        self.assertEqual(nodes[0].node.metadata, {})
        self.assertEqual(nodes[1].node.metadata, {"uid": "u1"})

    def test_retrieve_empty(self):
        with mock.patch("telonyte_brain.find", return_value={"lines": []}):
            self.assertEqual(self.retriever.retrieve("x"), [])
        with mock.patch("telonyte_brain.find", return_value={}):
            self.assertEqual(self.retriever.retrieve("x"), [])

    def test_add_and_delete(self):
        with mock.patch("telonyte_brain.add", return_value={"uid": "u9"}) as add:
            self.assertEqual(self.retriever.add("a note"), {"uid": "u9"})
        add.assert_called_once_with("support", "a note")
        with mock.patch("telonyte_brain.delete", return_value={"ok": True}) as delete:
            self.assertEqual(self.retriever.delete("u9"), {"ok": True})
        delete.assert_called_once_with("u9")


if __name__ == "__main__":
    unittest.main()
