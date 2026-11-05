"""Download one anonymous, single-page Bilibili audio into an owned temporary task."""
import asyncio
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from bilibili_api import video

ROOT = Path(__file__).parent.resolve()
MAX_SOURCE = 24 * 1024 * 1024
MAX_FLAC = 8 * 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def output_directory(value):
    directory = Path(value)
    resolved = directory.resolve(strict=True)
    if not directory.is_absolute() or not resolved.is_relative_to(ROOT / "state"):
        raise RuntimeError("MUSIC_ISOLATED_DIRECTORY_REQUIRED")
    for item in [directory, *directory.parents]:
        if item == ROOT:
            break
        if item.is_symlink() or getattr(item, "is_junction", lambda: False)():
            raise RuntimeError("MUSIC_ISOLATED_DIRECTORY_REQUIRED")
    if not re.fullmatch(r"task-[0-9a-f-]{36}", resolved.name):
        raise RuntimeError("MUSIC_TASK_REQUIRED")
    owner = json.loads((resolved / "owner.json").read_text(encoding="utf8"))
    if owner.get("schema") != "music-remote-task-v1" or owner.get("task") != resolved.name:
        raise RuntimeError("MUSIC_TASK_OWNER_REQUIRED")
    return resolved


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("MUSIC_REDIRECT_REJECTED")


def allowed_audio_url(url):
    if not isinstance(url, str) or any(ord(char) <= 32 for char in url):
        return False
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        return (parsed.scheme == "https" and parsed.username is None and parsed.password is None and
                parsed.port in [None, 443] and any(
                    host.endswith("." + suffix)
                    for suffix in ["bilivideo.com", "bilivideo.cn", "bilivideo.com.cn"]))
    except ValueError:
        return False


def select_audio_url(choices):
    if not choices:
        raise RuntimeError("MUSIC_NO_PUBLIC_AUDIO")
    for track in sorted(choices, key=lambda item: item.get("bandwidth", 0), reverse=True):
        backups = track.get("backupUrl") or track.get("backup_url") or []
        candidates = [track.get("baseUrl") or track.get("base_url")]
        if isinstance(backups, list):
            candidates.extend(backups)
        for url in candidates:
            if allowed_audio_url(url):
                return url
    raise RuntimeError("MUSIC_CDN_REJECTED")


def download(url, destination):
    if not allowed_audio_url(url):
        raise RuntimeError("MUSIC_CDN_REJECTED")
    request = Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/", "Accept-Encoding": "identity"})
    started = time.monotonic()
    with build_opener(NoRedirect()).open(request, timeout=15) as response, destination.open("xb") as target:
        if response.status != 200 or response.headers.get("Content-Encoding", "identity") != "identity":
            raise RuntimeError("MUSIC_MEDIA_REJECTED")
        length = response.headers.get("Content-Length")
        if length and int(length) > MAX_SOURCE:
            raise RuntimeError("MUSIC_SOURCE_SIZE_LIMIT")
        size = 0
        while True:
            if time.monotonic() - started > 40:
                raise RuntimeError("MUSIC_DOWNLOAD_TIMEOUT")
            block = response.read(65536)
            if not block:
                break
            size += len(block)
            if size > MAX_SOURCE:
                raise RuntimeError("MUSIC_SOURCE_SIZE_LIMIT")
            target.write(block)
        if not size or length and size != int(length):
            raise RuntimeError("MUSIC_SOURCE_INCOMPLETE")


async def locate(bvid):
    source = video.Video(bvid=bvid)
    info = await asyncio.wait_for(source.get_info(), 20)
    pages = info.get("pages", [])
    if len(pages) != 1:
        raise RuntimeError("MUSIC_MULTIPART_REQUIRES_SELECTION")
    page = pages[0]
    cid = page.get("cid")
    duration = page.get("duration")
    if not isinstance(cid, int) or cid <= 0 or not isinstance(duration, (int, float)) or not 0 < duration <= 300:
        raise RuntimeError("MUSIC_SOURCE_DURATION_LIMIT")
    media = await asyncio.wait_for(source.get_download_url(cid=cid), 20)
    choices = media.get("dash", {}).get("audio", [])
    return cid, select_audio_url(choices), str(info.get("title", ""))[:256]


def ffmpeg(args, input_data=None):
    completed = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-threads", "2", *args], input=input_data,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=False,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if completed.returncode:
        raise RuntimeError("MUSIC_AUDIO_PREPARATION_FAILED")
    return completed.stdout


def main():
    if len(sys.argv) != 3 or not re.fullmatch(r"BV[1-9A-HJ-NP-Za-km-z]{10}", sys.argv[1]):
        raise RuntimeError("MUSIC_SOURCE_ID_INVALID")
    bvid, directory = sys.argv[1], output_directory(sys.argv[2])
    started = time.monotonic()
    cid, url, title = asyncio.run(locate(bvid))
    original, encoded = directory / "source.m4a", directory / "whole.flac"
    download(url, original)
    # A 301-second decode ceiling rejects long inputs. Valid <=300-second
    # results reach actual decoder EOF before the ceiling; no tail is invented.
    pcm = ffmpeg(["-i", "pipe:0", "-t", "301", "-ar", "16000", "-ac", "1", "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"], original.read_bytes())
    if not pcm or len(pcm) % 2 or len(pcm) > 300 * 32000:
        raise RuntimeError("MUSIC_SOURCE_DURATION_LIMIT")
    data = ffmpeg(["-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0", "-map_metadata", "-1", "-c:a", "flac", "-compression_level", "5", "-f", "flac", "pipe:1"], pcm)
    if not data.startswith(b"fLaC") or len(data) > MAX_FLAC:
        raise RuntimeError("MUSIC_AUDIO_SIZE")
    with encoded.open("xb") as target:
        target.write(data)
    decoded = ffmpeg(["-i", "pipe:0", "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"], data)
    if decoded != pcm:
        raise RuntimeError("MUSIC_PCM_BINDING")
    print(json.dumps({"bvid": bvid, "cid": cid, "sourceSha256": sha(original.read_bytes()), "wholeSha256": sha(data),
                      "pcmSha256": sha(pcm), "seconds": len(pcm) / 32000, "bytes": len(data),
                      "sourceBytes": original.stat().st_size, "title": title, "completeEof": True,
                      "downloadAndPreparationMs": round((time.monotonic() - started) * 1000)}, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never expose request URLs, signed CDN query strings, or library traces.
        code = str(error) if re.fullmatch(r"MUSIC_[A-Z0-9_]{1,80}", str(error)) else "MUSIC_SOURCE_FETCH_FAILED"
        print(json.dumps({"error": code}))
        sys.exit(1)
