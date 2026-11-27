"""
Recupera lo storico di HRV, FC a riposo e sonno dall'esportazione di Apple Salute
e lo invia a intervals.icu (dati "wellness"), giorno per giorno.

Uso (da PowerShell, nella cartella del progetto):
    python tools\\salute_a_intervals.py "C:\\percorso\\esportazione.zip"
    python tools\\salute_a_intervals.py esportazione.zip --dal 2026-10-01
    python tools\\salute_a_intervals.py esportazione.zip --prova      (mostra i dati, non invia nulla)

La chiave API di intervals viene chiesta all'avvio e non viene salvata.
Funziona con il file .zip esportato da Salute oppure con export.xml già estratto.
Non servono librerie da installare: solo Python 3.
"""

import argparse
import base64
import getpass
import os
import json
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta

HRV = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN"
RHR = "HKQuantityTypeIdentifierRestingHeartRate"
SLEEP = "HKCategoryTypeIdentifierSleepAnalysis"
# Fasi di sonno vero (sono esclusi "a letto" e "sveglio")
ASLEEP = {
    "HKCategoryValueSleepAnalysisAsleep",
    "HKCategoryValueSleepAnalysisAsleepUnspecified",
    "HKCategoryValueSleepAnalysisAsleepCore",
    "HKCategoryValueSleepAnalysisAsleepDeep",
    "HKCategoryValueSleepAnalysisAsleepREM",
}
# Le misure prese di sera/notte vengono attribuite al giorno del risveglio
NIGHT_SHIFT = timedelta(hours=6)


def parse_dt(s):
    # Formato di Salute: "2026-10-05 23:10:00 +0200" -> ora locale (si ignora il fuso)
    return datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S")


def open_export(path):
    if path.lower().endswith(".zip"):
        z = zipfile.ZipFile(path)
        # Il nome dipende dalla lingua dell'iPhone ("export.xml", "dati esportati.xml", ...):
        # si prende il file XML più grande, escludendo export_cda.xml (formato clinico)
        xmls = [i for i in z.infolist() if i.filename.lower().endswith(".xml") and "cda" not in i.filename.lower()]
        if not xmls:
            sys.exit("Nel file zip non trovo i dati di Salute: è proprio l'esportazione di Salute?")
        name = max(xmls, key=lambda i: i.file_size).filename
        print(f"  file dati: {name}")
        return z.open(name)
    if "cda" in path.lower():
        sys.exit("export_cda.xml è il formato clinico: usa l'altro file XML (es. 'dati esportati.xml').")
    return open(path, "rb")


def read_export(path, since):
    hrv = defaultdict(list)
    rhr = defaultdict(list)
    sleep = defaultdict(list)  # giorno -> lista di intervalli (inizio, fine)
    n = 0
    with open_export(path) as f:
        # Lettura a pezzi: l'esportazione può pesare centinaia di MB
        for _, el in ET.iterparse(f, events=("end",)):
            if el.tag != "Record":
                if el.tag in ("Workout", "ActivitySummary", "Correlation"):
                    el.clear()
                continue
            n += 1
            if n % 200000 == 0:
                print(f"  ... letti {n:,} record", flush=True)
            t = el.get("type")
            if t in (HRV, RHR, SLEEP):
                start = parse_dt(el.get("startDate"))
                if t == HRV:
                    d = (start + NIGHT_SHIFT).date()
                    if d >= since:
                        # (valore, preso di notte?) — di notte = tra le 20 e le 10
                        hrv[d].append((float(el.get("value")), start.hour >= 20 or start.hour < 10))
                elif t == RHR:
                    d = start.date()
                    if d >= since:
                        rhr[d].append(float(el.get("value")))
                elif el.get("value") in ASLEEP:
                    end = parse_dt(el.get("endDate"))
                    d = end.date()  # la notte conta per il giorno in cui ti svegli
                    if d >= since and end > start:
                        sleep[d].append((start, end))
            el.clear()
    return hrv, rhr, sleep


def merged_seconds(intervals):
    # Unisce gli intervalli sovrapposti (iPhone e Watch registrano entrambi)
    total, cur_s, cur_e = 0, None, None
    for s, e in sorted(intervals):
        if cur_e is None or s > cur_e:
            if cur_e is not None:
                total += (cur_e - cur_s).total_seconds()
            cur_s, cur_e = s, e
        else:
            cur_e = max(cur_e, e)
    if cur_e is not None:
        total += (cur_e - cur_s).total_seconds()
    return int(total)


def build_days(hrv, rhr, sleep):
    days = {}
    for d in sorted(set(hrv) | set(rhr) | set(sleep)):
        rec = {}
        if hrv.get(d):
            # Si preferisce l'HRV notturna (a riposo, confrontabile tra i giorni); se manca, tutte le misure
            vals = [v for v, night in hrv[d] if night] or [v for v, _ in hrv[d]]
            rec["hrv"] = round(sum(vals) / len(vals), 1)
        if rhr.get(d):
            rec["restingHR"] = round(min(rhr[d]))
        secs = merged_seconds(sleep.get(d, []))
        if secs >= 2 * 3600:  # meno di 2 ore: probabilmente un pisolino o un dato parziale
            rec["sleepSecs"] = secs
        if rec:
            days[d] = rec
    return days


def put_wellness(auth, athlete, d, rec):
    url = f"https://intervals.icu/api/v1/athlete/{athlete}/wellness/{d.isoformat()}"
    req = urllib.request.Request(url, data=json.dumps(rec).encode(), method="PUT", headers={
        "Authorization": "Basic " + auth,
        "Content-Type": "application/json",
        "User-Agent": "bike-analytics-import",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')  # accenti corretti nel terminale di Windows
    ap = argparse.ArgumentParser(description="Storico Salute -> intervals.icu")
    ap.add_argument("file", help="esportazione.zip (o export.xml) di Apple Salute")
    ap.add_argument("--dal", help="primo giorno da inviare, AAAA-MM-GG (predefinito: 60 giorni fa)")
    ap.add_argument("--prova", action="store_true", help="mostra i dati senza inviare nulla")
    ap.add_argument("--atleta", default="0", help="ID atleta intervals (predefinito: 0 = il proprietario della chiave)")
    a = ap.parse_args()

    since = date.fromisoformat(a.dal) if a.dal else date.today() - timedelta(days=60)
    print(f"Leggo {a.file} (dal {since.strftime('%d/%m/%Y')})...")
    days = build_days(*read_export(a.file, since))
    if not days:
        sys.exit("Nessun dato di HRV, FC a riposo o sonno trovato in quel periodo.")

    print(f"\n{'Giorno':<12}{'HRV':>7}{'FC rip.':>9}{'Sonno':>8}")
    for d, r in days.items():
        s = f"{r['sleepSecs'] / 3600:.1f} h" if "sleepSecs" in r else "–"
        print(f"{d.strftime('%d/%m/%Y'):<12}{r.get('hrv', '–'):>7}{r.get('restingHR', '–'):>9}{s:>8}")
    cnt = lambda k: sum(1 for r in days.values() if k in r)
    print(f"\nTotale: {len(days)} giorni · HRV {cnt('hrv')} · FC a riposo {cnt('restingHR')} · sonno {cnt('sleepSecs')}")

    if a.prova:
        print("\nModalità prova: nulla è stato inviato.")
        return
    if input(f"\nInviare questi {len(days)} giorni a intervals.icu? (s/n) ").strip().lower() not in ("s", "si", "sì", "y"):
        print("Annullato.")
        return
    # Se hai salvato la chiave nella variabile d'ambiente INTERVALS_API_KEY non viene chiesta
    key = os.environ.get("INTERVALS_API_KEY", "").strip() or         getpass.getpass("Chiave API di intervals.icu (non viene mostrata né salvata): ").strip()
    auth = base64.b64encode(f"API_KEY:{key}".encode()).decode()

    ok = err = 0
    for i, (d, r) in enumerate(days.items(), 1):
        try:
            put_wellness(auth, a.atleta, d, r)
            ok += 1
        except urllib.error.HTTPError as e:
            err += 1
            print(f"  {d}: errore {e.code} {e.read()[:120].decode(errors='ignore')}")
            if e.code in (401, 403):
                sys.exit("Chiave API o ID atleta non validi: interrotto.")
        except urllib.error.URLError as e:
            err += 1
            print(f"  {d}: rete non raggiungibile ({e.reason})")
        print(f"\r  Inviati {i}/{len(days)}", end="", flush=True)
        time.sleep(0.15)  # per non sovraccaricare intervals
    print(f"\n\nFatto: {ok} giorni inviati{f', {err} errori' if err else ''}. Ora premi Sincronizza nell'app.")


if __name__ == "__main__":
    main()
