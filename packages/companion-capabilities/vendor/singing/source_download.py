"""Use the reviewed existing anonymous downloader; retain 44.1k stereo for singing.

No listening model, cookies, chat data or audio upload. FFmpeg is job-owned.
"""
import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent

def digest(file):
    h = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--bvid', required=True)
    p.add_argument('--directory', type=Path, required=True)
    p.add_argument('--downloader', type=Path, required=True)
    p.add_argument('--downloader-sha256', required=True)
    p.add_argument('--owned-process-dir', type=Path, required=True)
    a = p.parse_args()
    if not re.fullmatch(r'BV[1-9A-HJ-NP-Za-km-z]{10}', a.bvid):
        raise ValueError('SINGING_SOURCE_ID_INVALID')
    target = a.directory.resolve(strict=True)
    if not a.directory.is_absolute() or target.is_symlink() or not re.fullmatch(r'task-[a-f0-9-]{36}', target.name):
        raise ValueError('SINGING_SOURCE_DIRECTORY')
    owner = json.loads((target/'owner.json').read_text(encoding='utf8'))
    if owner.get('schema') != 'singing-source-v1' or owner.get('id') != target.name:
        raise ValueError('SINGING_SOURCE_OWNER')
    if digest(a.downloader) != a.downloader_sha256:
        raise ValueError('SINGING_DOWNLOADER_CHANGED')
    spec = importlib.util.spec_from_file_location('reviewed_bilibili_source', str(a.downloader))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.path.insert(0, str(a.owned_process_dir))
    from owned_process import spawn_owned, stop_owned_tree
    cid, url, title = asyncio.run(module.locate(a.bvid))
    original, output = target/'source.m4a', target/'whole.wav'
    module.download(url, original)
    process = None
    try:
        with (target/'ffmpeg.log').open('xb') as log:
            process = spawn_owned(['ffmpeg', '-v','error','-nostdin','-threads','2','-i',str(original),
                '-t','301','-ar','44100','-ac','2','-map_metadata','-1','-c:a','pcm_s24le',str(output)],
                stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            if process.wait(timeout=20) != 0:
                raise ValueError('SINGING_SOURCE_DECODE_FAILED')
    finally:
        if process is not None:
            stop_owned_tree(process)
    details = json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','a:0',
        '-show_entries','stream=sample_rate,channels,duration_ts,time_base','-of','json',str(output)],
        timeout=10,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0)).decode('utf8'))['streams'][0]
    frames = int(details['duration_ts'])
    if details['sample_rate']!='44100' or details['channels']!=2 or details['time_base']!='1/44100' or not 0 < frames <= 300*44100:
        raise ValueError('SINGING_SOURCE_DURATION_LIMIT')
    result = {'identity':{'bvid':a.bvid,'cid':cid,'sourceSha256':digest(original)},'path':str(output),
              'sha256':digest(output),'frames':frames,'seconds':frames/44100,'title':title,'completeEof':True}
    (target/'recording.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(result,ensure_ascii=True))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message=str(error)
        print(json.dumps({'error':message if re.fullmatch(r'(?:SINGING|MUSIC)_[A-Z_]+',message) else 'SINGING_SOURCE_FETCH_FAILED'}))
        sys.exit(1)
