import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("matcher", Path(__file__).with_name("german-matcher.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def card(i):
    return {"videoId": f"{i:011}", "title": f"How to build your workshop {i}", "badge": "10:00"}


def hit(i):
    return {"id": f"{i+1000:011}", "title": "So bauen wir eine Werkstatt", "channel_id": f"UC{i}", "duration": 600}


def settings(**changes):
    return dict(enabled=True, targetPercent=100, creatorLimit=3, searchBudget=2,
                replacementPositions=list(range(1,11)), rowPositions={},
                excludedRows=[], pinnedOriginals=[], trustedChannels=[], blockedChannels=[], **changes)


class MatcherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {"DATA_DIR": self.temp.name})
        self.env.start()
        self.addCleanup(self.env.stop)
        real_cache=m.Cache
        def cache():
            value=real_cache()
            self.addCleanup(value.db.close)
            return value
        self.cache_patch=patch.object(m,"Cache",side_effect=cache)
        self.cache_patch.start()
        self.addCleanup(self.cache_patch.stop)
        self.audio = patch.object(m.AudioChecks, "check", side_effect=lambda vid: {"language":"de","checkedAt":int(m.time.time()*1000)})
        self.audio.start()
        self.addCleanup(self.audio.stop)

    def test_language_and_duration(self):
        self.assertEqual(m.title_language("How to build your workshop"), "en")
        self.assertEqual(m.title_language("So baust du deine Werkstatt"), "de")
        self.assertEqual(m.title_language("RTX 5090"), "und")
        self.assertEqual(m.seconds("1:02:03"), 3723)
        self.assertEqual(m.seconds("LIVE"), 0)

    def test_first_eligible_search_hit_and_controls(self):
        s = settings()
        saved = {"entries": [hit(i) for i in range(5)], "checkedAt": 123}
        saved["entries"][0]["title"] = "How to build your workshop"
        s["blockedChannels"] = ["UC1"]
        saved["entries"][2]["duration"] = 30
        audio = m.AudioChecks(m.Cache(), 2)
        found = m.first_match(card(0), "Werkstatt bauen", saved, s, {hit(3)["id"]}, {}, audio)
        self.assertEqual(found["replacement"]["videoId"], hit(4)["id"])
        self.assertNotIn("quality", found)
        self.assertIsNone(m.first_match(card(0), "Werkstatt bauen", saved, s, {hit(3)["id"]}, {"UC4": 3}, audio))
        s["trustedChannels"] = ["UC4"]
        found = m.first_match(card(0), "Werkstatt bauen", saved, s, set(), {}, audio)
        self.assertEqual(found["replacement"]["videoId"], hit(4)["id"])
        self.assertEqual(found["evidence"]["searchRank"], 5)
        short = {**card(0), "isShorts": True, "badge": "0:40"}
        saved["entries"][2]["duration"] = 600
        self.assertIsNone(m.first_match(short, "Werkstatt", saved, s, set(), {}, audio))

    def test_search_only_uses_flat_results(self):
        result = subprocess.CompletedProcess([], 0, json.dumps({"entries": [hit(0)]}).encode(), b"")
        with patch.object(m.subprocess, "run", return_value=result) as run:
            self.assertEqual(m.search("Werkstatt", m.Cache()), [hit(0)])
        args = run.call_args.args[0]
        self.assertIn("--flat-playlist", args)
        self.assertIn("--no-write-subs", args)
        self.assertIn("--no-write-auto-subs", args)
        self.assertEqual(args[-1], "ytsearch5:Werkstatt deutsch")
        self.assertEqual(run.call_count, 1)

    def test_one_translation_batch_records_usage_without_auth(self):
        cards = [card(0), card(1)]
        response = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({
            "translations": [{"id": c["videoId"], "language": "en", "query": "Werkstatt bauen"} for c in cards]})}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 50, "prompt_cache_hit_tokens": 20}}
        with patch.object(m, "key", return_value="secret-test-key"), patch.object(m.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = io.BytesIO(json.dumps(response).encode())
            cache = m.Cache()
            translated, usage = m.translate(cards, cache)
        self.assertEqual(len(translated), 2)
        self.assertEqual(usage["apiCalls"], 1)
        self.assertAlmostEqual(usage["estimatedCostUsd"], (80*.30+20*.006+50*1.20)/1e6)
        stored = cache.db.execute("SELECT request,response,input_tokens,output_tokens FROM calls").fetchone()
        self.assertNotIn("secret-test-key", stored[0]+stored[1])
        self.assertEqual(stored[2:], (100, 50))
        self.assertEqual(len(json.loads(json.loads(stored[0])["messages"][1]["content"])), 2)
        cache.db.close()

    def test_quota_cache_rotation_and_owner_controls(self):
        data = {"settings": settings(), "rows": [{"id": f"row-{r}", "items": [card(r*10+i) for i in range(10)]} for r in range(3)]}
        data["rows"].append({"id": "non-video", "items": [{"videoId": None, "title": "Recommended playlists", "playlistId": "list"}]})
        data["settings"]["excludedRows"] = ["row-2"]
        data["settings"]["pinnedOriginals"] = ["00000000001"]
        batches = []
        def translate(cards, cache):
            batches.append(copy.deepcopy(cards))
            return {c["videoId"]: {"language": "en", "query": f"Werkstatt bauen {c['videoId']}"} for c in cards}, {}
        def search(query, cache):
            return [hit(int(query.split()[-1]))]
        with patch.object(m, "translate", side_effect=translate), patch.object(m, "search", side_effect=search) as searches, patch.object(m.time, "time", return_value=100*m.WINDOW+10), patch.object(m.sys, "stderr", io.StringIO()):
            first = m.run(data)
            again = m.run(data)
            self.assertEqual(searches.call_count, 2)
            self.assertEqual(len(batches), 1)
            self.assertEqual(first["matches"], again["matches"])
            self.assertEqual(again["report"]["cached"], 2)
            self.assertEqual(again["report"]["searchesThisCycle"], 2)
            self.assertTrue(all(int(c["videoId"]) < 20 and int(c["videoId"]) != 1 for batch in batches for c in batch))
            with patch.object(m.time, "time", return_value=101*m.WINDOW+10):
                next_cycle = m.run(data)
            self.assertEqual(searches.call_count, 4)
            self.assertEqual(len(next_cycle["matches"]), 4)
            self.assertTrue(set(c["videoId"] for c in batches[0]).isdisjoint(c["videoId"] for c in batches[1]))
            self.assertEqual([c["videoId"] for c in batches[0]], [card(0)["videoId"],card(2)["videoId"]])
        cache = m.Cache()
        self.assertEqual(cache.db.execute("SELECT count(*) FROM searches").fetchone()[0], 4)
        cache.db.close()

    def test_search_budget_is_persistent_and_shared(self):
        first, second = m.Cache(), m.Cache()
        self.assertTrue(first.reserve_search("one", "eins", 1))
        self.assertFalse(second.reserve_search("two", "zwei", 1))
        first.db.close()
        second.db.close()

    def test_fill_continues_past_small_budget_stops_at_target_then_reuses_cache(self):
        data = {"settings": settings(), "fillTarget": True,
                "rows": [{"id": f"row-{r}", "items": [card(i) for i in range(r*10,r*10+10)]} for r in range(8)]}
        data["settings"]["targetPercent"] = 30
        def translate(cards, cache):
            return {c["videoId"]: {"language": "en", "query": f"Werkstatt {c['videoId']}"} for c in cards}, {}
        def search(query, cache):
            i=int(query.split()[-1])
            return [hit(i)] if i % 2 == 0 else []
        with patch.object(m, "translate", side_effect=translate), patch.object(m, "search", side_effect=search) as searches, patch.object(m.time, "time", return_value=100*m.WINDOW+10), patch.object(m.sys, "stderr", io.StringIO()):
            result=m.run(data)
            self.assertEqual(result["report"]["searches"], 24)
            self.assertGreater(result["report"]["remaining"], 0)
            for _ in range(10):
                if not result["report"]["remaining"]:
                    break
                result=m.run(data)
            self.assertEqual(len(result["matches"]), 24)
            self.assertEqual(result["report"]["targetRemaining"], 0)
            self.assertEqual(result["report"]["remaining"], 0)
            before=searches.call_count
            data["fillTarget"]=False
            maintained=m.run(data)
            self.assertEqual(maintained["report"]["searchBudget"], 2)
            self.assertEqual(searches.call_count, before)
            self.assertEqual(maintained["matches"], result["matches"])

    def test_fill_is_bounded_even_when_no_results_are_eligible(self):
        data = {"settings": settings(), "fillTarget": True,
                "rows": [{"id": f"row-{r}", "items": [card(r*10+i) for i in range(10)]} for r in range(20)]}
        def translate(cards, cache):
            return {c["videoId"]: {"language": "en", "query": f"Werkstatt {c['videoId']}"} for c in cards}, {}
        with patch.object(m, "translate", side_effect=translate), patch.object(m, "search", return_value=[]) as searches, patch.object(m.time, "time", return_value=100*m.WINDOW+10), patch.object(m.sys, "stderr", io.StringIO()):
            for _ in range(10):
                result=m.run(data)
                if result["report"]["remaining"]==0:
                    break
            self.assertEqual(searches.call_count, 150)
            self.assertEqual(result["report"]["searchesThisCycle"], 150)
            self.assertEqual(result["report"]["remaining"], 0)
            self.assertEqual(len(result["matches"]), 0)
            m.run(data)
            self.assertEqual(searches.call_count, 150)

    def test_exact_slots_limit_search_work_and_row_off_reuses_nothing(self):
        data={"settings":settings(),"fillTarget":True,"rows":[{"id":"row","items":[card(i) for i in range(20)]}]}
        data["settings"]["replacementPositions"]=[2,6,9]
        data["settings"]["pinnedOriginals"]=[card(1)["videoId"]]
        def translate(cards,cache):
            return {c["videoId"]:{"language":"en","query":f"Werkstatt {c['videoId']}"} for c in cards},{}
        with patch.object(m,"translate",side_effect=translate),patch.object(m,"search",side_effect=lambda q,c:[hit(int(q.split()[-1]))]) as searches,patch.object(m.sys,"stderr",io.StringIO()):
            result=m.run(data)
            self.assertEqual(len(result["matches"]),2)
            self.assertEqual([x["original"] for x in result["matches"]],[card(5)["videoId"],card(8)["videoId"]])
            self.assertEqual(searches.call_count,2)
            data["settings"]["rowPositions"]["row"]=[]
            self.assertEqual(m.run(data)["matches"],[])
            self.assertEqual(searches.call_count,2)

    def test_localized_titles_dubs_unknown_and_conflicting_audio_are_rejected(self):
        def track(lang, original=True):
            return {"acodec":"opus","language":lang,"format_note":"original" if original else "dubbed",
                    "language_preference":10 if original else -1}
        self.assertEqual(m.original_audio({"language":"de","formats":[track("en-US"),track("de",False)]}),"en")
        self.assertEqual(m.original_audio({"language":"de","formats":[track("de",False)]}),"und")
        self.assertEqual(m.original_audio({"formats":[track("de-DE"),track("de")]}),"de")
        self.assertEqual(m.original_audio({"formats":[track("de"),track("en")]}),"und")
        saved={"entries":[hit(i) for i in range(3)],"checkedAt":123}
        with patch.object(m.AudioChecks,"check",side_effect=[
            {"language":"en","checkedAt":123},{"language":"und","checkedAt":123},{"language":"de","checkedAt":123}]):
            result=m.first_match(card(0),"Werkstatt",saved,settings(),set(),{},m.AudioChecks(m.Cache(),2))
        self.assertEqual(result["evidence"]["searchRank"],3)
        self.assertEqual(result["evidence"]["audioLanguage"],"de")

    def test_audio_metadata_cache_quota_timeout_and_no_transcripts(self):
        self.audio.stop()
        cache=m.Cache()
        info={"id":hit(0)["id"],"formats":[{"acodec":"opus","language":"de-DE","format_note":"German original"}]}
        result=subprocess.CompletedProcess([],0,json.dumps(info).encode(),b"")
        with patch.object(m.subprocess,"run",return_value=result) as process:
            audio=m.AudioChecks(cache,1)
            self.assertEqual(audio.check(info["id"])["language"],"de")
            self.assertEqual(audio.check(info["id"])["language"],"de")
            self.assertEqual(process.call_count,1)
            self.assertIn("--no-write-subs",process.call_args.args[0])
            self.assertIn("--no-write-auto-subs",process.call_args.args[0])
            self.assertNotIn("--flat-playlist",process.call_args.args[0])
            for i in range(1,10):
                audio.check(hit(i)["id"])
            self.assertEqual(process.call_count,5)
            self.assertIsNone(m.AudioChecks(cache,1).check(hit(9)["id"]))
        with patch.object(m.subprocess,"run",side_effect=subprocess.TimeoutExpired([],40)):
            self.assertEqual(m.AudioChecks(cache,2).check(hit(10)["id"])["language"],"und")
        self.assertEqual(set(cache.read("original-audio-v1",info["id"])),{"language","checkedAt"})

    def test_short_full_rows_and_caps_do_not_waste_searches(self):
        data={"settings":settings(),"rowLimits":{"full":10},"rows":[
            {"id":"short","items":[card(i) for i in range(9)]},
            {"id":"full","items":[card(i) for i in range(10)]}]}
        with patch.object(m,"translate") as translate,patch.object(m.sys,"stderr",io.StringIO()):
            self.assertEqual(m.run(data)["matches"],[])
            translate.assert_not_called()

    def test_audio_batch_limit_defers_and_resumes_using_cached_rejections(self):
        self.audio.stop()
        cache=m.Cache()
        response=subprocess.CompletedProcess([],0,b'{}',b'')
        with patch.object(m.subprocess,"run",return_value=response) as process:
            first=m.AudioChecks(cache,12)
            for i in range(30):
                first.check(hit(i)["id"])
            self.assertEqual(process.call_count,24)
            self.assertEqual(first.deferred,6)
            second=m.AudioChecks(cache,12)
            for i in range(30):
                second.check(hit(i)["id"])
            self.assertEqual(process.call_count,30)
            self.assertEqual(second.deferred,0)

    def test_full_row_retains_originals_without_discounting_their_creators(self):
        data={"settings":settings(),"fillTarget":True,"rowLimits":{"row":20},
              "rows":[{"id":"row","items":[card(i) for i in range(20)]}]}
        data["settings"]["replacementPositions"]=[2,6,9]
        data["settings"]["creatorLimit"]=1
        data["rows"][0]["items"][1]["channelId"]="UC5"
        def translate(cards,cache):
            return {c["videoId"]:{"language":"en","query":f"Werkstatt {c['videoId']}"} for c in cards},{}
        with patch.object(m,"translate",side_effect=translate),patch.object(m,"search",side_effect=lambda q,c:[hit(int(q.split()[-1]))]),patch.object(m.sys,"stderr",io.StringIO()):
            result=m.run(data)
        self.assertEqual([x["original"] for x in result["matches"]],[card(1)["videoId"],card(8)["videoId"]])
        self.assertEqual(result["report"]["decisions"][card(5)["videoId"]]["status"],"no-eligible-match")


if __name__ == "__main__":
    unittest.main()
