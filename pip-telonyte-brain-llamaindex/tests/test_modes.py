import unittest
from unittest import mock

from telonyte_brain_llamaindex import BrainRetriever


class LastModeTest(unittest.TestCase):
    def test_last_mode_and_reason_follow_each_call(self):
        r = BrainRetriever(bot="support", k=3)
        self.assertEqual((r.last_mode, r.last_reason), (None, None))
        with mock.patch("telonyte_brain.find", return_value={"lines": ["a"], "mode": "local", "reason": "synced"}):
            r.retrieve("x")
        self.assertEqual((r.last_mode, r.last_reason), ("local", "synced"))
        with mock.patch("telonyte_brain.find", return_value={"lines": ["a"], "mode": "host", "reason": "serverless"}):
            r.retrieve("x")
        self.assertEqual((r.last_mode, r.last_reason), ("host", "serverless"))
        with mock.patch("telonyte_brain.find", return_value={"lines": []}):  # an older package answers without them
            r.retrieve("x")
        self.assertEqual((r.last_mode, r.last_reason), (None, None))


if __name__ == "__main__":
    unittest.main()
