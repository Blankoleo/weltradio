#!/usr/bin/env python3
"""Baut geo.json: alle https-Sender mit Ortsangabe aus Radio Browser, kompakt fuer die Karte.

Format: [[uuid, name, lat, lon, clickcount, countrycode], ...] nach clickcount absteigend.
Nur Standardbibliothek. Aufruf: python3 tools/build-geo.py  (schreibt geo.json im Repo-Hauptordner)
"""
import json
import os
import re
import sys
import unicodedata
import urllib.request

HOSTS = ['de1', 'fi1', 'nl1', 'de2']
QUERY = '/json/stations/search?hidebroken=true&is_https=true&has_geo_info=true&limit=200000'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'geo.json')


def fetch():
    err = None
    for h in HOSTS:
        url = f'https://{h}.api.radio-browser.info{QUERY}'
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Weltradio-geo-build/1.0'})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # naechster Spiegel
            err = e
            print(f'{h}: {e}', file=sys.stderr)
    raise SystemExit(f'Kein Radio-Browser-Server erreichbar: {err}')


def norm(s):
    s = unicodedata.normalize('NFD', str(s or '').lower())
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


def main():
    rows = fetch()
    rows.sort(key=lambda r: -(r.get('clickcount') or 0))
    out, seen = [], set()
    for r in rows:
        lat, lon = r.get('geo_lat'), r.get('geo_long')
        name = re.sub(r'\s+', ' ', str(r.get('name') or '')).strip()[:60]
        url = str(r.get('url_resolved') or '')
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
            continue
        if not name or not url.lower().startswith('https://') or r.get('lastcheckok') != 1:
            continue
        cc = str(r.get('countrycode') or '').upper()[:2]
        key = norm(name) + '|' + cc
        uid = r.get('stationuuid')
        if not uid or key in seen:  # Doppel: nur den beliebtesten behalten
            continue
        seen.add(key)
        out.append([uid, name, round(lat, 3), round(lon, 3), int(r.get('clickcount') or 0), cc])
    if len(out) < 1000:
        raise SystemExit(f'Nur {len(out)} Sender – vermutlich Fehler, geo.json bleibt unveraendert.')
    data = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(data)
    print(f'geo.json: {len(out)} Sender, {len(data.encode()) / 1024:.0f} KB')


if __name__ == '__main__':
    main()
