"""Read a dated academic XLSX without Excel or third-party dependencies."""
import argparse
import datetime as dt
import hashlib
import html
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
BELLS = [('08:15', '09:00'), ('09:05', '09:50'), ('10:10', '10:55'),
         ('11:00', '11:45'), ('14:30', '15:15'), ('15:20', '16:05'),
         ('16:25', '17:10'), ('17:15', '18:00'), ('19:30', '20:15'), ('20:20', '21:05')]


def read_cells(source):
    with zipfile.ZipFile(source) as book:
        if len(book.infolist()) > 2000 or sum(i.file_size for i in book.infolist()) > 16 * 1024 * 1024:
            raise ValueError('Workbook exceeds import limits')
        shared = []
        if 'xl/sharedStrings.xml' in book.namelist():
            shared = [''.join(t.text or '' for t in x.iter('{%s}t' % NS['s']))
                      for x in ET.fromstring(book.read('xl/sharedStrings.xml')).findall('s:si', NS)]
        workbook = ET.fromstring(book.read('xl/workbook.xml'))
        sheets = workbook.find('s:sheets', NS)
        first = sheets[0]
        rid = first.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
        rels = ET.fromstring(book.read('xl/_rels/workbook.xml.rels'))
        target = next(x.get('Target') for x in rels if x.get('Id') == rid)
        target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
        root = ET.fromstring(book.read(target))
        cells = {}
        for c in root.findall('s:sheetData/s:row/s:c', NS):
            if c.find('s:f', NS) is not None:
                raise ValueError('Formula cells need explicit review: ' + c.get('r'))
            v = c.find('s:v', NS)
            if c.get('t') == 's':
                value = shared[int(v.text)]
            elif c.get('t') == 'inlineStr':
                value = ''.join(t.text or '' for t in c.iter('{%s}t' % NS['s']))
            else:
                value = v.text if v is not None else ''
            if value:
                cells[c.get('r')] = value
        return cells, first.get('name')


def column(index):
    result = ''
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def col_index(text):
    value = 0
    for char in text:
        value = value * 26 + ord(char) - 64
    return value


def parse_course_cell(raw):
    lines = [html.unescape(x).strip() for x in raw.splitlines() if x.strip()]
    heads = [i for i, x in enumerate(lines) if re.fullmatch(r'.+\[[^\]]+\]', x)]
    if not heads or heads[0] != 0:
        raise ValueError('Cannot identify course heading')
    records = []
    for n, start in enumerate(heads):
        chunk = lines[start:heads[n + 1] if n + 1 < len(heads) else len(lines)]
        codes = [(i, re.fullmatch(r'(\d{1,2})-((?:\d{2})+)', x)) for i, x in enumerate(chunk)]
        codes = [(i, match) for i, match in codes if match]
        if len(codes) != 1:
            raise ValueError('Expected one week/period marker per course')
        code_index, code = codes[0]
        if code_index not in (1, 2):
            raise ValueError('Unrecognized teacher field layout')
        periods = [int(x) for x in re.findall(r'\d{2}', code.group(2))]
        if not periods or any(x < 1 or x > len(BELLS) for x in periods) or periods != sorted(set(periods)):
            raise ValueError('Unknown or unordered periods: ' + code.group(0))
        title = re.fullmatch(r'(.+)\[([^\]]+)\]', chunk[0])
        records.append(dict(name=title.group(1), kind=title.group(2),
                            teacher=chunk[1] if code_index == 2 else '',
                            room=chunk[code_index + 1] if len(chunk) > code_index + 1 else '',
                            week=int(code.group(1)), periods=periods,
                            notes='\n'.join(chunk[code_index + 2:])))
    return records


def import_book(source):
    source = pathlib.Path(source)
    cells, sheet = read_cells(source)
    title = cells.get('A1', '')
    years = re.search(r'(20\d{2})-(20\d{2})', title)
    if not years:
        raise ValueError('Missing academic years')
    start_year, end_year = map(int, years.groups())
    if end_year != start_year + 1:
        raise ValueError('Unexpected academic year range')
    first_month = int(cells['B3'].split('-')[0])
    headers = [(a, int(m.group(1))) for a, text in cells.items()
               if (m := re.fullmatch(r'第(\d+)周', text))]
    warnings, errors, dates, courses = [], [], set(), {}
    source_cells = 0
    for address, week in headers:
        match = re.fullmatch(r'([A-Z]+)(\d+)', address)
        left, row = col_index(match.group(1)), int(match.group(2))
        for offset in range(7):
            col = column(left + offset)
            date_cell = col + str(row + 1)
            md = cells.get(date_cell, '')
            if not md:
                for course_row in range(row + 3, row + 10):
                    if cells.get(col + str(course_row)):
                        errors.append({'cell': col + str(course_row), 'error': 'Course without date'})
                continue
            try:
                month, day = map(int, md.split('-'))
                date = dt.date(start_year if month >= first_month else end_year, month, day)
            except Exception as error:
                errors.append({'cell': date_cell, 'error': str(error)})
                continue
            dates.add(date.isoformat())
            if date.weekday() != offset:
                warnings.append({'type': 'weekday_mismatch', 'cell': date_cell, 'date': date.isoformat()})
            if offset == 6:
                monday = cells.get(column(left) + str(row + 1), '')
                if monday and md < monday:
                    warnings.append({'type': 'sunday_precedes_group_monday', 'cell': date_cell,
                                     'date': date.isoformat(), 'policy': 'preserve_explicit_date'})
            for big in range(7):
                cell = col + str(row + 3 + big)
                raw = cells.get(cell)
                if not raw:
                    continue
                source_cells += 1
                try:
                    parsed = parse_course_cell(raw)
                    for item in parsed:
                        if item['week'] != week:
                            warnings.append({'type': 'week_marker_mismatch', 'cell': cell,
                                             'headerWeek': week, 'courseWeek': item['week']})
                        key = json.dumps([date.isoformat(), item['name'], item['kind'], item['teacher'],
                                          item['room'], item['periods']], ensure_ascii=False)
                        identity = hashlib.sha256(key.encode()).hexdigest()[:20]
                        if identity not in courses:
                            courses[identity] = dict(id=identity, date=date.isoformat(), **item,
                                                    start=BELLS[item['periods'][0] - 1][0],
                                                    end=BELLS[item['periods'][-1] - 1][1], sources=[])
                        courses[identity]['sources'].append({'sheet': sheet, 'cell': cell, 'raw': raw})
                except ValueError as error:
                    errors.append({'cell': cell, 'error': str(error)})
    ordered = sorted(courses.values(), key=lambda x: (x['date'], x['start'], x['id']))
    conflicts = []
    for i, course in enumerate(ordered):
        for other in ordered[i + 1:]:
            if other['date'] != course['date']:
                break
            overlap = sorted(set(course['periods']) & set(other['periods']))
            if overlap:
                conflicts.append({'date': course['date'], 'courseIds': [course['id'], other['id']], 'periods': overlap})
    if not dates or not ordered:
        errors.append({'error': 'No dated courses imported'})
    dataset = dict(schemaVersion=1, timezone='Asia/Shanghai', academicYears=[start_year, end_year],
                   sourceName=source.name, sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                   bells=[dict(period=i + 1, start=a, end=b) for i, (a, b) in enumerate(BELLS)],
                   coveredDates=sorted(dates), courses=ordered, conflicts=conflicts)
    dataset['revision'] = hashlib.sha256(json.dumps(dataset, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    report = dict(sourceCells=source_cells, courses=len(ordered), coveredDates=len(dates),
                  coverage=[min(dates), max(dates)] if dates else [], warnings=warnings,
                  conflicts=conflicts, errors=errors, sourceSha256=dataset['sourceSha256'])
    return dataset, report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('--output', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    data, report = import_book(args.source)
    for file, value in [(args.report, report)] + ([] if report['errors'] else [(args.output, data)]):
        target = pathlib.Path(file)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(target.suffix + '.tmp')
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temp.replace(target)
    print(json.dumps({k: v for k, v in report.items() if k not in ('warnings', 'conflicts', 'errors')}, ensure_ascii=False))
    print(json.dumps({'warnings': len(report['warnings']), 'conflicts': len(report['conflicts']), 'errors': report['errors']}, ensure_ascii=False))
    return 1 if report['errors'] else 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
