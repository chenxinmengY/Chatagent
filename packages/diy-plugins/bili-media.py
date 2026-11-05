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
    def url(row):
        return row.get('baseUrl') or row.get('base_url') or row.get('url')
    combined = download.get('durl', [])
    video_url = url(videos[0]) if videos else url(combined[0]) if len(combined) == 1 else None
    audio_url = url(audios[0]) if audios else video_url
    if not video_url or not audio_url:
        return {'error': 'PLUGIN_MEDIA_UNAVAILABLE'}
    return {'bvid': value, 'cid': page['cid'], 'title': str(info.get('title', ''))[:200], 'duration': duration,
            'videoUrl': video_url, 'audioUrl': audio_url}

if __name__ == '__main__':
    try:
        print(json.dumps(asyncio.run(asyncio.wait_for(main(), 30)), ensure_ascii=False))
    except Exception:
        print(json.dumps({'error': 'PLUGIN_BILI_SOURCE_FAILED'}))
        sys.exit(1)
