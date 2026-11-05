"""Read-only source; optional isolated credentials arrive through stdin only."""
import argparse
import asyncio
import json
import math
import re
import sys
from urllib.parse import urlparse

sys.dont_write_bytecode = True


async def request(action, value, credential=None):
    from bilibili_api import hot, video
    from bilibili_api.exceptions import CredentialNoSessdataException
    if action == "hot":
        if value != "1":
            raise ValueError("BILI_ARGUMENT_INVALID")
        data = await hot.get_hot_videos(pn=1, ps=10)
        result = {"videos": [{"bvid": r.get("bvid"), "title": str(r.get("title", ""))[:200],
                              "description": str(r.get("desc", ""))[:200]}
                             for r in data.get("list", [])[:10]]}
    elif action == "subtitle":
        if not re.fullmatch(r"BV[1-9A-HJ-NP-Za-km-z]{10}", value):
            raise ValueError("BILI_ARGUMENT_INVALID")
        import aiohttp
        v = video.Video(bvid=value, credential=credential)
        info = await v.get_info()
        page = info.get("pages", [])[0]
        cid, duration = page.get("cid"), page.get("duration")
        if not isinstance(cid, int) or cid <= 0 or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
            raise ValueError("BILI_IDENTITY_INVALID")
        result = {"bvid": value, "cid": cid, "duration": duration, "title": str(info.get("title", ""))[:200], "subtitles": []}
        try:
            subtitle_info = await v.get_subtitle(cid=cid)
        except CredentialNoSessdataException:
            result["unavailable"] = "subtitle-login-required"
            return {"action": action, "untrusted": True, "anonymous": credential is None, "data": result}
        tracks = (subtitle_info or {}).get("subtitles", [])
        if not tracks:
            result["unavailable"] = "no-public-subtitles"
        else:
            track = next((s for s in tracks if s.get("lan") in ("ai-zh", "zh-CN", "zh")), tracks[0])
            url = track.get("subtitle_url", "")
            if url.startswith("//"):
                url = "https:" + url
            parsed = urlparse(url)
            if parsed.scheme != "https" or parsed.username or parsed.password or not any((parsed.hostname or "") == d or (parsed.hostname or "").endswith("." + d) for d in ("hdslb.com", "bilibili.com")):
                raise ValueError("BILI_SUBTITLE_ORIGIN_REFUSED")
            async with aiohttp.ClientSession() as session:
                async with session.get(url, allow_redirects=False) as response:
                    if response.status != 200:
                        raise ValueError("BILI_SUBTITLE_UNAVAILABLE")
                    chunks, size = [], 0
                    async for chunk in response.content.iter_chunked(65536):
                        size += len(chunk)
                        if size > 1024 * 1024:
                            raise ValueError("BILI_SUBTITLE_TOO_LARGE")
                        chunks.append(chunk)
                    rows = json.loads(b"".join(chunks)).get("body")
            if not isinstance(rows, list) or len(rows) > 6000:
                raise ValueError("BILI_SUBTITLE_TOO_LARGE")
            for row in rows:
                start, end, text = row.get("from"), row.get("to"), row.get("content")
                if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or not math.isfinite(start) or not math.isfinite(end) or not 0 <= start < end <= duration + 1 or not isinstance(text, str):
                    raise ValueError("BILI_SUBTITLE_INVALID")
                result["subtitles"].append(text)
            if sum(map(len, result["subtitles"])) > 18000:
                raise ValueError("BILI_SUBTITLE_TOO_LARGE")
    else:
        raise ValueError("BILI_ACTION_REFUSED")
    return {"action": action, "untrusted": True, "anonymous": credential is None, "data": result}


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("hot", "subtitle"))
    parser.add_argument("value")
    parser.add_argument("--credential-stdin", action="store_true")
    args = parser.parse_args()
    try:
        credential = None
        if args.credential_stdin:
            from bilibili_api import Credential
            values = json.loads(sys.stdin.read(32768))
            if not values.get('sessdata') or not values.get('bili_jct') or set(values) - {'sessdata', 'bili_jct', 'dedeuserid', 'buvid3', 'buvid4', 'ac_time_value'}:
                raise ValueError('BILI_CREDENTIAL_INVALID')
            credential = Credential(**values)
        result = await asyncio.wait_for(request(args.action, args.value, credential), 25)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        # Never expose upstream response bodies or account information to logs.
        print(json.dumps({"ok": False, "error": type(error).__name__}))
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
