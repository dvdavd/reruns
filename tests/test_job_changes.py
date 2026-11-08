import unittest

from reruns.job_changes import JobChanges


def job(job_id, *items, state="running"):
    return {"id": job_id, "state": state, "items": [dict(item) for item in items]}


class JobChangesTests(unittest.TestCase):
    def test_a_first_poll_gets_everything(self):
        answer = JobChanges().since("", [job("a", {"id": "1", "percent": 0})], "")
        self.assertTrue(answer["full"])
        self.assertEqual(answer["jobs"], [{"id": "a", "state": "running", "itemIds": ["1"],
                                           "items": [{"id": "1", "percent": 0}]}])

    def test_only_the_moving_video_is_sent_again(self):
        changes = JobChanges()
        items = [{"id": str(n), "percent": 0} for n in range(3)]
        token = changes.since("", [job("a", *items), job("b", {"id": "x"})], "")["since"]
        items[1]["percent"] = 50
        answer = changes.since("", [job("a", *items), job("b", {"id": "x"})], token)
        self.assertFalse(answer["full"])
        self.assertEqual(answer["order"], ["a", "b"])
        self.assertEqual(answer["jobs"], [{"id": "a", "items": [{"id": "1", "percent": 50}]},
                                          {"id": "b", "unchanged": True}])
        # Nothing moved since: every job is a stub.
        again = changes.since("", [job("a", *items), job("b", {"id": "x"})], answer["since"])
        self.assertEqual(again["since"], answer["since"])
        self.assertTrue(all(entry.get("unchanged") for entry in again["jobs"]))

    def test_a_changed_job_brings_its_fields_and_order(self):
        changes = JobChanges()
        token = changes.since("", [job("a", {"id": "1"})], "")["since"]
        answer = changes.since("", [job("a", {"id": "1"}, {"id": "2"}, state="done")], token)
        self.assertEqual(answer["jobs"], [{"id": "a", "state": "done", "itemIds": ["1", "2"],
                                           "items": [{"id": "2"}]}])

    def test_two_pages_on_old_and_new_tokens_both_catch_up(self):
        changes = JobChanges()
        items = [{"id": "1", "percent": 0}]
        old = changes.since("", [job("a", *items)], "")["since"]
        items[0]["percent"] = 10
        changes.since("", [job("a", *items)], old)
        answer = changes.since("", [job("a", *items)], old)
        self.assertEqual(answer["jobs"], [{"id": "a", "items": [{"id": "1", "percent": 10}]}])

    def test_a_token_from_before_a_restart_gets_everything(self):
        changes = JobChanges()
        token = changes.since("", [job("a")], "")["since"]
        for stale in ("other.1", token.partition(".")[0] + ".999", "junk"):
            self.assertTrue(JobChanges().since("", [job("a")], stale)["full"])
            self.assertTrue(changes.since("", [job("a")], stale)["full"])

    def test_viewers_are_stamped_apart(self):
        changes = JobChanges()
        token = changes.since("one", [job("a")], "")["since"]
        changes.since("two", [job("a", state="done")], "")
        self.assertEqual(changes.since("one", [job("a")], token)["jobs"],
                         [{"id": "a", "unchanged": True}])


if __name__ == "__main__":
    unittest.main()
