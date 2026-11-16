"""Read-only Bilibili metadata. No account or browser profile is read."""
import asyncio
import json
import re
import sys

async def main():
    from bilibili_api import hot, video
    action, value = sys.argv[1:]
    if action == 'hot':
        result = await hot.get_hot_videos(pn=1, ps=10)
        return {'candidates': [{'bvid': r['bvid'], 'title': str(r.get('title', ''))[:200], 'duration': r['duration']}
                               for r in result.get('list', [])[:10] if isinstance(r.get('duration'), (int, float)) and 0 < r['duration'] <= 600]}
    if action != 'media' or not re.fullmatch(r'BV[1-9A-HJ-NP-Za-km-z]{10}', value):
        raise ValueError('invalid request')
    item = video.Video(bvid=value)
    info = await item.get_info()
    page = info['pages'][0]
    duration = page['duration']
    if not isinstance(duration, (float, int)) or duration <= 0 or duration > 600:
        return {'error': 'PLUGIN_VIDEO_TOO_LONG'}
    download = await item.get_download_url(cid=page['cid'])
    dash = download.get('dash', {})
    videos = sorted(dash.get('video', []), key=lambda r: (r.get('height', 99999), r.get('bandwidth', 99999999)))
    audios = sorted(dash.get('audio', []), key=lambda r: r.get('bandwidth', 99999999))
    def urls(row):
        primary = row.get('baseUrl') or row.get('base_url') or row.get('url')
        backups = row.get('backupUrl') or row.get('backup_url') or []
        return list(dict.fromkeys(u for u in [primary, *backups] if isinstance(u, str) and u))
    combined = download.get('durl', [])
    video_urls = urls(videos[0]) if videos else urls(combined[0]) if len(combined) == 1 else []
    audio_urls = urls(audios[0]) if audios else video_urls
    if not video_urls or not audio_urls:
        return {'error': 'PLUGIN_MEDIA_UNAVAILABLE'}
    return {'bvid': value, 'cid': page['cid'], 'title': str(info.get('title', ''))[:200], 'duration': duration,
            'videoUrl': video_urls[0], 'audioUrl': audio_urls[0],
            'videoBackupUrls': video_urls[1:], 'audioBackupUrls': audio_urls[1:]}

if __name__ == '__main__':
    try:
        print(json.dumps(asyncio.run(asyncio.wait_for(main(), 30)), ensure_ascii=False))
    except Exception:
        print(json.dumps({'error': 'PLUGIN_BILI_SOURCE_FAILED'}))
        sys.exit(1)
