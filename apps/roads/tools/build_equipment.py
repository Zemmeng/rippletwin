#!/usr/bin/env python3
"""Purpose: generate public/<area>/equipment.json, the works equipment inventory (type, specifications, what each item does in the model, quantity and day rate). Format: PRD-2 section 3A.

Usage: python3 apps/roads/tools/build_equipment.py [--area cbd]
Exit code: 0 success
Dependencies: Python standard library only.

Sources (checked 2026-09-29):
  - Specifications: RPM Hire product pages (each item's url). Only type, specifications and link are recorded; no images or long passages are copied
  - Sign codes: only verified ones are filled in (TfNSW sign register: T1-1 Roadwork Ahead, T2-16 End Roadwork); the rest are null, not guessed
  - RPM Hire has no product page for static signs, so static sign urls are null and sizes follow common AS 1742.3 dimensions
  - RPM Hire publishes no prices: qty and day_rate_aud are all assumptions, listed in each item's assumed
"""
import argparse, json, os

MOD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RPM = 'https://www.rpmhire.com.au/products/'
CATEGORIES = ('barrier', 'sign', 'vms', 'arrow_board', 'ped_signal')
EFFECTS = ('close', 'route_vehicles', 'route_peds', 'warn', 'message', 'control_crossing')
ASSUMED = ['qty', 'day_rate_aud']

ITEMS = [
    # ---- Barriers: effect=close, enclosing what is listed in can_close ----
    {'id': 'barrier_water', 'category': 'barrier', 'name': 'Water-filled barrier (ArmorZone)',
     'effect': 'close', 'can_close': ['lane', 'footpath', 'bike_lane'], 'applies_to': ['vehicle', 'ped', 'bike'],
     'unit_len_m': 2.0, 'width_m': 0.45, 'weight_kg': {'empty': 56, 'filled': 496},
     'rating': 'MASH TL1/TL2', 'max_speed_kmh': 70, 'note': 'RPM Hire: suited to roads up to 50 km/h, maximum 70; smooth surface, friendlier to pedestrians and cyclists',
     'qty': 200, 'day_rate_aud': 4, 'url': RPM + 'water-filled-barriers/'},
    {'id': 'barrier_klemmfix', 'category': 'barrier', 'name': 'Klemmfix plastic guidance barrier',
     'effect': 'close', 'can_close': ['lane', 'bike_lane'], 'applies_to': ['vehicle', 'bike'],
     'unit_len_m': 1.0, 'height_m': 0.99, 'weight_kg': {'panel': 2.1, 'base': 16},
     'rating': None, 'note': 'plastic guidance panels that spring back when hit; not a crash barrier',
     'qty': 300, 'day_rate_aud': 2, 'url': RPM + 'klemmfix/'},
    {'id': 'barrier_steel', 'category': 'barrier', 'name': 'Steel barrier (BG800)',
     'effect': 'close', 'can_close': ['lane'], 'applies_to': ['vehicle'],
     'unit_len_m': 6.0, 'height_m': 0.8, 'weight_kg_per_m': 90,
     'rating': 'NCHRP350 TL-3/TL-4, MASH TL-3', 'max_speed_kmh': 100, 'note': 'also available in 12 m sections; minimum deflection 13 cm',
     'qty': 40, 'day_rate_aud': 20, 'url': RPM + 'steel-barriers/'},
    # ---- Static signs: no RPM Hire product page ----
    {'id': 'sign_roadwork_ahead', 'category': 'sign', 'name': 'Roadwork ahead', 'code': 'T1-1',
     'effect': 'warn', 'applies_to': ['vehicle', 'bike'], 'qty': 30, 'day_rate_aud': 5, 'url': None},
    {'id': 'sign_lane_closed_left', 'category': 'sign', 'name': 'Left lane closed', 'code': None,
     'effect': 'warn', 'applies_to': ['vehicle'], 'side': 'left', 'qty': 20, 'day_rate_aud': 5, 'url': None},
    {'id': 'sign_lane_closed_right', 'category': 'sign', 'name': 'Right lane closed', 'code': None,
     'effect': 'warn', 'applies_to': ['vehicle'], 'side': 'right', 'qty': 20, 'day_rate_aud': 5, 'url': None},
    {'id': 'sign_detour_left', 'category': 'sign', 'name': 'Detour (left)', 'code': None,
     'effect': 'route_vehicles', 'applies_to': ['vehicle'], 'dir': 'left', 'qty': 20, 'day_rate_aud': 5, 'url': None},
    {'id': 'sign_detour_right', 'category': 'sign', 'name': 'Detour (right)', 'code': None,
     'effect': 'route_vehicles', 'applies_to': ['vehicle'], 'dir': 'right', 'qty': 20, 'day_rate_aud': 5, 'url': None},
    {'id': 'sign_detour_straight', 'category': 'sign', 'name': 'Detour (straight ahead)', 'code': None,
     'effect': 'route_vehicles', 'applies_to': ['vehicle'], 'dir': 'straight', 'qty': 20, 'day_rate_aud': 5, 'url': None},
    {'id': 'sign_footpath_closed', 'category': 'sign', 'name': 'Footpath closed, use other side', 'code': None,
     'effect': 'route_peds', 'applies_to': ['ped'], 'qty': 30, 'day_rate_aud': 5, 'url': None},
    {'id': 'sign_bike_lane_closed', 'category': 'sign', 'name': 'Bike lane closed / Bicycles merge', 'code': None,
     'effect': 'warn', 'applies_to': ['bike'], 'qty': 20, 'day_rate_aud': 5, 'url': None,
     'note': 'bicycles merge into the traffic lane; the effect list has no "reroute cyclists", so warn + applies_to is used for now'},
    {'id': 'sign_end_roadwork', 'category': 'sign', 'name': 'End roadwork', 'code': 'T2-16',
     'effect': 'warn', 'applies_to': ['vehicle', 'bike'], 'qty': 30, 'day_rate_aud': 5, 'url': None,
     'note': 'has no effect in the model; listed for completeness, with warn as a placeholder effect'},
    # ---- VMS: effect=message, free text ----
    # The RPM Hire page contradicts itself (original text checked 29 Sep): the FAQ says "12-13 characters per line up to 4 lines of text per screen",
    # the message guide says "Up to 10 characters per line (including any spaces)", "Ideally, 3 lines of text and 8 characters per line"
    # and "Generally 2 seconds for 1,2 or 3 lines of text. 3 seconds if the screen is flashing".
    # 10 is used: it matches readSigns() / /api/read in apps/api (longer lines get a 400), as @jinmingq pointed out in #14
    {'id': 'vms_a', 'category': 'vms', 'name': 'Variable Message Sign (A class, trailer)',
     'effect': 'message', 'applies_to': ['vehicle', 'bike'], 'lines': 4, 'chars_per_line': 10,
     'lines_recommended': 3, 'chars_recommended': 8, 'seconds_per_screen': 2, 'seconds_per_screen_flashing': 3,
     'display_m': [1.04, 1.62], 'power': 'solar + battery',
     'note': 'RPM Hire message guide: up to 10 characters per line (including spaces), up to 4 lines per screen; ideally 3 lines × 8 characters; 2 seconds per screen (3 seconds when flashing). The FAQ on the same page says 12–13 characters; 10 is used',
     'qty': 4, 'day_rate_aud': 150, 'url': RPM + 'variable-message-signs/'},
    {'id': 'vms_c', 'category': 'vms', 'name': 'Variable Message Sign (C class, trailer)',
     'effect': 'message', 'applies_to': ['vehicle', 'bike'], 'lines': 4, 'chars_per_line': 10,
     'lines_recommended': 3, 'chars_recommended': 8, 'seconds_per_screen': 2, 'seconds_per_screen_flashing': 3,
     'display_m': [1.85, 2.73], 'power': 'solar + battery',
     'note': 'larger characters than A class, legible from further away; same character rules as A class (up to 10 per line, ideally 3 lines × 8)',
     'qty': 2, 'day_rate_aud': 200, 'url': RPM + 'variable-message-signs/'},
    # ---- Arrow boards: show vehicles which way to merge ----
    {'id': 'arrow_board', 'category': 'arrow_board', 'name': 'Portable arrow board (trailer)',
     'effect': 'route_vehicles', 'applies_to': ['vehicle'], 'modes': ['left', 'right', 'double'],
     'panel_m': [2.4, 1.2], 'lamps': 15, 'power': 'solar + battery', 'note': 'RPM Hire: VicRoads / RMS approved',
     'qty': 4, 'day_rate_aud': 100, 'url': RPM + 'arrow-boards/'},
    # ---- Portable pedestrian signals ----
    {'id': 'ped_signal_portable', 'category': 'ped_signal', 'name': 'Pedestrian portable traffic lights',
     'effect': 'control_crossing', 'applies_to': ['ped', 'vehicle'], 'lantern_mm': 200,
     'standard': 'AS 4191:2015', 'power': 'solar + battery', 'note': 'one set is a primary and a secondary unit linked wirelessly; flashes amber if the link is lost',
     'qty': 3, 'day_rate_aud': 250, 'url': RPM + 'pedestrian-portable-traffic-lights/'},
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--area', default='cbd')
    a = ap.parse_args()
    items = [dict(it, assumed=list(ASSUMED)) for it in ITEMS]
    for it in items:
        assert it['category'] in CATEGORIES and it['effect'] in EFFECTS, it['id']
    out = {
        'version': 1,
        'sources': ['RPM Hire product pages (types, specifications), checked 2026-09-29', 'TfNSW sign register (T1-1, T2-16)',
                    'Quantities and day rates are assumptions; RPM Hire publishes no prices'],
        'categories': list(CATEGORIES), 'effects': list(EFFECTS),
        'items': items,
    }
    d = os.path.join(MOD, 'public', a.area)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, 'equipment.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    by = {}
    for it in items:
        by[it['category']] = by.get(it['category'], 0) + 1
    print('✅ equipment.json: %d item types (%s); %d KB' % (len(items), ', '.join('%s %d' % kv for kv in by.items()), os.path.getsize(p) // 1024))


if __name__ == '__main__':
    main()
