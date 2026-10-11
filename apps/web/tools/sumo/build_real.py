#!/usr/bin/env python3
"""SUMO replay on the real CBD network (contract v2 "real network").
Network = apps/roads/public/cbd/network.json (OSM), signalised sites = signals.json (SCATS), demand = flows.json weekday 08:00–09:00.
Three scenarios: baseline (no works) / original (one lane closed + the original plan's diversion share) / ai (one lane closed + the AI plan's diversion share).
Runs the full hour 08:00–09:00 (starts from an empty network at 07:57 with 180 s of warm-up that is not shown; the works close at exactly 08:00); SUMO computes the 09:00 queue itself.
The network is extended east (Albert St beyond Spring St), south (to Collins St) and north (past La Trobe St) so queues and spill-back have room.
Replays are written only for original / ai and only for vehicles inside the page's view (baseline produces metrics only).
Options mode: options = [{id:'A'…'E', p}] → baseline + one opt-<id> per option (one lane closed + that option's diversion share p), metrics only by default;
options with the same p run once and the rest copy it (reused_from). The original {p_original, p_ai, scenarios} output is unchanged.
Runs native SUMO only and never fabricates trajectories; the network and candidate routes are cached in SUMO_REAL_CACHE (default: the system temp directory), and the same seed reproduces the same result.
Run it in the venv from requirements.txt; the first cache build also needs numpy + scipy (for SUMO's bundled routeSampler.py).
"""
import argparse
import bisect
import hashlib
import json
import math
import os
import platform
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
VERSION = '1.27.1'
HOUR = 8
# Local planar coordinates (equirectangular approximation): net coordinates = xy(lat, lon); netconvert has offset normalisation disabled, so the inverse is exact
LAT0, LON0 = -37.8115, 144.9660
KX, KY = math.cos(math.radians(LAT0))*111320.0, 110540.0
# Frame along Lonsdale St: u = metres from Spring/Lonsdale towards Elizabeth/Lonsdale (west positive), v = lateral metres (south positive)
# Measured: Exhibition u≈233, Russell 462, 2935 582, Elizabeth 925; La Trobe v≈−231, Little Lonsdale −116, Little Bourke 115, Bourke 230, Collins 461
SPRING_LONSDALE, ELIZABETH_LONSDALE = (-37.809404, 144.97214), (-37.812282, 144.962257)
# Study area = union of two u/v rectangles (leaving room for queues and spill-back):
#   the original Elizabeth–Spring × Bourke–La Trobe (35 m margin);
#   east of Russell St to the eastern edge of network.json (Albert St past Gisborne St, so the Lonsdale westbound queue can continue east), south to Collins (+35 m) and about 170 m north of La Trobe.
# Tried cutting only the Albert St corridor, without the large merged OSM junctions at Victoria Pde / Nicholson St (which cannot insert vehicles under netconvert's default signal plans even without works):
# routeSampler picked a different set of routes, southbound Russell traffic entering north of La Trobe locked up turning right at Russell × Lonsdale, and in the no-works scenario at 09:00
# nearly 200 vehicles bound through the works were waiting to enter the network — worse than keeping the north-east corner, so it stays; the north-east insertion backlog is unrelated to the works (reported as insertion_backlog_end)
AREA_BOXES = [(-35, 985, -266, 266), (-345, 500, -400, 496)]
# Page view (replays only include vehicles inside it): the 16 junctions of La Trobe–Little Bourke × Elizabeth–Exhibition (12 m margin, just enough to cover the outer streets' carriageways),
# extended 140 m east (towards Spring). One frame every 2 s for an hour is about 15 MB per scenario; any wider would exceed that
VIEW_BOX = (93, 937, -243, 127)
WORKS = 'l595594354_9756035316'  # Lonsdale westbound, 42 m between Russell St and the 2935 pedestrian signal, two lanes
WORKS_LANE = WORKS+'_1'          # in a left-hand-traffic network, index 1 = the median-side (right) lane
WORKS_SPEED = 30/3.6             # the remaining lane is limited to 30 km/h
# Lonsdale westbound links upstream of the works, nearest first, out to Spring (junction-internal segments are bridged by the 60 m gap rule); Albert St westbound further east is joined along the network in prepare()
CHAIN = ['l595594353_595594354','l595594352_595594353','l6696274751_9756035317','l6381474061_6696274751',
         'l595594348_6381474061','l6207022860_595594347','l6207022858_6207022860','l317537930_6207022858']
CHAIN_NAMES = ('Lonsdale Street', 'Albert Street')
# Detour: Lonsdale westbound turns left at Russell (kerbside, no conflict with oncoming traffic) → Little Bourke westbound → Swanston → Lonsdale
DETOUR_TURN, DETOUR_FIRST = 'l6696274751_9756035317', 'l1985557927_13807338304'
# Side effect of the study-area cut: some through vehicles end on two very short links past the works (QV / car park side) that detouring vehicles cannot get back to; send them to Lonsdale westbound Swanston→Elizabeth instead
DEST_FIX = {'l9756035316_4544002877':'l9086096512_2190483592','l4544002877_9756035309':'l9086096512_2190483592'}
SITE_2935 = {'n245537592','n4544002877','n9756035315','n9756035316'}  # nodes of the carriageways either side of LONSDALE NR SWANSTON (POS)
CYCLE = 90
# Share of the cycle (green + amber) that 2935 gives Lonsdale traffic (assumption). Set to 50%: about 1,800 veh/h through two lanes and about 800 veh/h with one closed,
# matching the engine's capacity assumption (1,800 × ½ × 0.9 = 810 veh/h); the measured discharge is written to metrics.works_throughput_vph
GREEN_2935 = .50
ENGINE_CAPACITY_VPH = 810        # engine: works link 1,800 veh/h × half the lanes left × 0.9
PRE = 180                        # empty network from 07:57:00; the first 180 s are warm-up (no works yet) and not shown; the works close at exactly 08:00:00 (rerouter + speed sign)
SHOWN = 3600                     # shown: 08:00–09:00
END = PRE+SHOWN
STEP = .5
SAMPLE = 2                       # one replay frame every 2 s (same period as the FCD)
CHUNK_FRAMES = 60                # 60 frames per chunk = 2 minutes
CHUNK_BYTES = 1300000            # hard limit of 1.5 MB per file, with headroom
QUEUE_SPEED = 1.5                # queue: vehicles slower than 1.5 m/s with gaps ≤ 60 m form one chain
QUEUE_GAP = 60
HALT_SPEED = .1                  # SUMO's definition of halting
HARSH_DECEL = -4.5               # harsh braking: reaching SUMO's maximum normal deceleration for passenger cars, 4.5 m/s² (about 0.46 g); counted once per vehicle per event
VEH_M, LANES_M = 7.0, 2          # engine conversion: 7 m per vehicle, spread over two lanes
# Deadlock guard: crossing traffic stops yielding to a vehicle that has blocked a junction for ≥ 60 s (SUMO --ignore-junction-blocker); only a vehicle that has not moved at all for ≥ 300 s is teleported ahead (SUMO default).
# A trial run with teleporting fully disabled: in the no-works scenario, from 07:03 a right-turning vehicle at Little Bourke × Swanston could not find space downstream and a loop of Swanston / La Trobe / Elizabeth locked up;
# at 09:00 more than 500 vehicles were stationary — a deadlock of SUMO's junction model, not caused by the works. Vehicles in the works queue move up every signal cycle (90 s),
# well within 300 s, so they are never teleported; every teleport is recorded in the metrics (total, on the works route, which links)
JUNCTION_BLOCKER_S = 60
TELEPORT_S = 300
CAR = (4.6,1.8)
SCENARIOS = {'baseline':{'en':'No works','zh':'无施工','closed':False,'frames':False},
             'original':{'en':'Original plan · ROADWORK AHEAD','zh':'原方案 · ROADWORK AHEAD','closed':True,'frames':True},
             'ai':{'en':'AI plan · USE RUSSELL','zh':'AI 方案 · USE RUSSELL','closed':True,'frames':True}}
DEFAULTS = {'seed':42,'p_original':.14,'p_ai':.53,'scenarios':list(SCENARIOS)}
NETWORK_EXTENT = {'en':'Elizabeth St to Spring St by Bourke St to La Trobe St, plus room for the queue from Russell St east to the edge of the data (Albert St to Gisborne St, Nicholson St, Victoria Pde), south to Collins St and about 170 m north of La Trobe St',
                  'zh':'Elizabeth St–Spring St × Bourke St–La Trobe St，再给排队留地方：Russell St 以东到数据边界（Albert St 到 Gisborne St、Nicholson St、Victoria Pde），南到 Collins St，北过 La Trobe St 约 170 m'}
ASSUMPTIONS = {
 'en':['Model cross-check, not a field measurement: Eclipse SUMO on the real CBD street geometry.',
       'Network: OSM links from network.json — {extent} (+35 m margin); lane counts and speed limits from OSM; living streets, kerbside parking and clearways not modelled.',
       'Demand: SCATS weekday 08:00–09:00 counts per link (flows.json, 38 weekdays; links without a detector interpolated), routes fitted with SUMO routeSampler, the full hour simulated; cars only (no trams, buses or trucks).',
       'Signals: SCATS gives counts but no timings, so every signal runs SUMO\'s fixed 90 s default plan; the pedestrian signal 2935 (Lonsdale near Swanston) at the works gives Lonsdale traffic {green}% of the cycle. Chosen so the works link matches the engine\'s capacity assumption (1,800 veh/h × ½ lane × 0.9 = 810 veh/h); the discharge SUMO actually achieved is reported as works_throughput_vph.',
       'Works: from 08:00:00 the right (median) lane of Lonsdale St westbound is closed on the 42 m link before signal 2935; the open lane runs at 30 km/h.',
       'Diversion: a fixed share of drivers who pass the sign (Lonsdale westbound before Russell St, heading through the works) turn left into Russell St, then Little Bourke St, Swanston St and back to Lonsdale St. Shares come from the engine\'s reading of each sign (ROADWORK AHEAD 14%, USE RUSSELL / SAVE 9 MIN 53%); no dynamic route choice.',
       'Time: the simulation starts empty at 07:57:00 with 08:00 demand and no works; 07:57–08:00 is warm-up and not shown. Shown and measured: 08:00–09:00. Delay = time loss including waiting to enter, accumulated by 09:00, same vehicles in every scenario.',
       'Jams are kept: vehicles are never removed. A vehicle blocking a junction for 60 s is ignored by crossing traffic (SUMO ignore-junction-blocker), and only a vehicle that has not moved at all for 300 s is moved ahead along its route (SUMO teleport, its default time) — so a model deadlock cannot lock the grid. Queued traffic behind the works moves up every 90 s cycle and is never moved; every teleport is counted and located in the metrics (teleports_in_hour, teleports_works_bound, teleport_edges).',
       'Queue at 09:00: physical = back of the stopped queue on the Lonsdale / Albert St westbound chain, longest over the last 90 s signal cycle; engine method = vehicles bound through the works that are queued behind it (connected queue, including spill-back onto Russell / Exhibition / Spring St) or still waiting to enter the network, averaged over the last cycle, × 7 m ÷ 2 lanes.'],
 'zh':['这是模型之间的交叉检验，不是实测：在真实 CBD 街道几何上跑 Eclipse SUMO。',
       '路网：network.json 的 OSM 路段——{extent}（外扩 35 m）；车道数和限速取 OSM；不含 living street、路边停车和清道时段。',
       '需求：SCATS 工作日 08:00–09:00 各路段流量（flows.json，38 个工作日；没有检测器的路段是插值），路线用 SUMO routeSampler 拟合，整小时都跑；只有小汽车（没有电车、公交、货车）。',
       '信号：SCATS 只有流量没有配时，所有信号灯用 SUMO 默认的 90 s 定周期；施工点的人行灯 2935（Lonsdale 近 Swanston）给 Lonsdale 车流 {green}% 的周期。这样取是为了让施工段对上引擎的通行能力假设（1 800 辆/小时 × 剩一半车道 × 0.9 = 810 辆/小时）；SUMO 实际放行多少写在 works_throughput_vph。',
       '施工：08:00:00 起 Lonsdale St 西行、2935 人行灯前那段 42 m 封右侧（中央侧）车道，剩下一条车道限速 30 km/h。',
       '绕行：经过指示牌的司机（Russell St 之前的 Lonsdale 西行、要穿过施工段）按固定比例左转 Russell St → Little Bourke St → Swanston St → 回到 Lonsdale St。比例取引擎对各块牌子的读法（ROADWORK AHEAD 14%，USE RUSSELL / SAVE 9 MIN 53%），不做动态选路。',
       '时间：07:57:00 空网开始，用 08:00 的车流、还没施工；07:57–08:00 预热不展示。展示和统计：08:00–09:00。延误 = 损失时间（含等着进路网的时间），算到 09:00，各情景用同一批车比。',
       '堵车照实留着：车不会被删掉。堵在路口里 60 s 的车，横向车流不再让它（SUMO ignore-junction-blocker）；只有整整 300 s 一动不动的车才会沿路线挪到前面（SUMO 的瞬移，默认时间），免得模型死锁把整片路网锁死。施工后面排队的车每 90 s 周期都会往前挪，不会被挪走；每一次瞬移都记数、记位置（teleports_in_hour、teleports_works_bound、teleport_edges）。',
       '09:00 的排队：实际排队 = Lonsdale / Albert St 西行这一串上停着的车队尾，取最后一个 90 s 信号周期里最长的；引擎算法 = 要穿过施工段、排在它后面的车（连成一串的排队，含回溢到 Russell / Exhibition / Spring St 上的）加上还没能进路网的，取最后一个周期的平均 × 7 m ÷ 2 条车道。']}


def dump(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',',':'))+'\n', encoding='utf-8')


def xml(path, root):
    ET.indent(root)
    ET.ElementTree(root).write(path, encoding='utf-8', xml_declaration=True)


def command(args, cwd, timeout=300):
    p = subprocess.run([str(x) for x in args], cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    if p.returncode:
        raise RuntimeError(' '.join(map(str, args[:2]))+' failed:\n'+p.stdout[-6000:])
    return p.stdout


def roads_dir():
    return Path(os.environ.get('SUMO_ROADS_DIR') or REPO/'apps/roads/public/cbd')


def binaries():
    exe = Path(sys.executable).parent
    bins = {n: str(exe/n) if (exe/n).exists() else shutil.which(n) for n in ['sumo','netconvert']}
    if not all(bins.values()):
        raise RuntimeError('Install tools/sumo/requirements.txt in a virtual environment first.')
    out = command([bins['sumo'],'--version'], tempfile.gettempdir())
    version = next((l.strip() for l in out.splitlines() if l.startswith('Eclipse SUMO')), out.strip()[:200])
    if VERSION not in version:
        raise RuntimeError('Expected SUMO '+VERSION+', got '+version)
    home = os.environ.get('SUMO_HOME')
    if not home or not (Path(home)/'tools/routeSampler.py').exists():
        import sumo
        home = sumo.SUMO_HOME
    return bins, version, Path(home)/'tools'


def xy(lat, lon):
    return ((lon-LON0)*KX, (lat-LAT0)*KY)


def lonlat_e6(x, y):
    return round((LON0+x/KX)*1e6), round((LAT0+y/KY)*1e6)


def _uv_frame():
    sx, sy = xy(*SPRING_LONSDALE); ex, ey = xy(*ELIZABETH_LONSDALE)
    L = math.hypot(ex-sx, ey-sy); ux, uy = (ex-sx)/L, (ey-sy)/L
    return lambda x, y: ((x-sx)*ux+(y-sy)*uy, (x-sx)*(-uy)+(y-sy)*ux)


UV = _uv_frame()  # net coordinates (x, y) → (u, v)


def in_box(box, u, v):
    return box[0] <= u <= box[1] and box[2] <= v <= box[3]


def centre(x, y, angle, length):
    """FCD reports the front bumper; stepping back half a vehicle length along the heading (0 = north, clockwise) gives the vehicle centre."""
    r = math.radians(angle)
    return x-math.sin(r)*length/2, y-math.cos(r)*length/2


def plain_network(folder):
    """network.json → plain nod / edg XML for the study area (as in the prototype build_net.py). The works do not change the network; works.add.xml closes the lane at 08:00."""
    net = json.loads((roads_dir()/'network.json').read_text())
    keep = {n['id'] for n in net['nodes'] if any(in_box(b, *UV(*xy(n['lat'], n['lon']))) for b in AREA_BOXES)}
    links = [l for l in net['links'] if l['from'] in keep and l['to'] in keep and l['highway'] != 'living_street']
    used = {l['from'] for l in links} | {l['to'] for l in links}
    N = {n['id']: n for n in net['nodes']}
    nodes = ET.Element('nodes')
    for nid in sorted(used):
        n = N[nid]; x, y = xy(n['lat'], n['lon'])
        a = {'id':nid,'x':'%.2f' % x,'y':'%.2f' % y,'type':'priority'}
        if n.get('signal'):
            a.update(type='traffic_light', tl='tls'+n['signal'])  # OSM nodes of the same SCATS site share one controller
        ET.SubElement(nodes, 'node', a)
    edges = ET.Element('edges')
    for l in links:
        ET.SubElement(edges, 'edge', {'id':l['id'],'from':l['from'],'to':l['to'],'numLanes':str(max(1, int(l['lanes'] or 1))),
            'speed':'%.2f' % ((l['speed_kmh'] or 40)/3.6),'shape':' '.join('%.2f,%.2f' % xy(p[0], p[1]) for p in l['geometry']),
            'name':l['name'] or 'unnamed','type':l['highway'],
            'priority':{'primary':'4','secondary':'3','tertiary':'2'}.get(l['highway'],'1')})
    xml(folder/'cbd.nod.xml', nodes); xml(folder/'cbd.edg.xml', edges)
    return len(used), len(links)


def netconvert(folder, bins, name, green):
    command([bins['netconvert'],'--node-files','cbd.nod.xml','--edge-files','cbd.edg.xml','--lefthand','true','--no-turnarounds','true',
             '--tls.guess-signals','false','--tls.guess','false','--junctions.join','true','--junctions.join-dist','12','--tls.join','true',
             '--tls.default-type','static','--tls.cycle.time',str(CYCLE),'--keep-edges.components','1','--junctions.corner-detail','5',
             '--rectangular-lane-cut','true','--edges.join','false','--geometry.remove','false','--offset.disable-normalization','true',
             '--no-warnings','true','--output-file',name], folder)
    # 2935 pedestrian signal: netconvert's default is 82 s green / 3 s amber / 5 s red; change it to the assumed green split
    tree = ET.parse(folder/name); root = tree.getroot(); patched = 0
    for tl in root.findall('tlLogic'):
        if not any(n in tl.get('id') for n in SITE_2935):
            continue
        ph = tl.findall('phase')
        if len(ph) != 3 or 'G' not in ph[0].get('state') or set(ph[1].get('state')) != {'y'}:
            raise RuntimeError('Unexpected 2935 signal plan '+tl.get('id'))
        g = round(CYCLE*green)-3
        for p, d in zip(ph, [g, 3, CYCLE-g-3]):
            p.set('duration', str(d))
        patched += 1
    if patched != 2:
        raise RuntimeError('Expected two 2935 controllers, patched %d' % patched)
    tree.write(folder/name, encoding='utf-8', xml_declaration=True)


def cache_key(version, green):
    h = hashlib.sha256(Path(__file__).read_bytes()+version.encode()+repr(green).encode())
    for f in ['network.json','signals.json','flows.json']:
        h.update((roads_dir()/f).read_bytes())
    return h.hexdigest()[:16]


def gap(a, b):
    """The junction-internal segment: straight-line distance from the end of one link to the start of the next (approximation)."""
    p, q = a.getShape()[-1], b.getShape()[0]
    return math.hypot(p[0]-q[0], p[1]-q[1])


def works_chain(net):
    """Westbound chain upstream of the works: CHAIN (to Spring), then on east along Lonsdale / Albert St to the edge of the study area. Returns [(edge, off)],
    off = distance from this link's downstream end to the start of the works (junctions in between bridged in a straight line)."""
    chain, e, acc = [], net.getEdge(WORKS), 0.0
    while True:
        ins = [c for c in e.getIncoming() if c.getName() in CHAIN_NAMES and c.getID() not in {x for x, _ in chain} and c.getID() != WORKS]
        if not ins:
            break
        nxt = min(ins, key=lambda c: gap(c, e))
        acc += gap(nxt, e)
        chain.append((nxt.getID(), round(acc, 1)))
        acc += nxt.getLength(); e = nxt
    ids = [x for x, _ in chain]
    if ids[:len(CHAIN)] != CHAIN:
        raise RuntimeError('Works chain changed: '+' '.join(ids[:len(CHAIN)]))
    return chain


def to_works(net, edges):
    """For each link on the route before the works, the distance "link end → start of the works"; None if the route does not pass through the works."""
    if WORKS not in edges: return None
    w = edges.index(WORKS); out = {}; acc = 0.0
    for i in range(w-1, -1, -1):
        a, b = net.getEdge(edges[i]), net.getEdge(edges[i+1])
        acc += gap(a, b)
        out[edges[i]] = round(acc, 1)
        acc += a.getLength()
    return out


def prepare(bins, version, tools, green=GREEN_2935):
    """Build (or reuse) the cache: base.net.xml, demand.json (routes picked by routeSampler + vehicles per hour + detour routes + distances to the works)."""
    root = Path(os.environ.get('SUMO_REAL_CACHE') or Path(tempfile.gettempdir())/'rippletwin-sumo-real-cache')
    cache = root/cache_key(version, green)
    if (cache/'demand.json').exists():
        return cache
    root.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix='build-', dir=root))
    try:
        d = tmp/'base'; d.mkdir()
        nodes, links = plain_network(d)
        netconvert(d, bins, 'base.net.xml', green)
        shutil.move(str(d/'base.net.xml'), str(tmp/'base.net.xml'))
        sys.path.insert(0, str(tools))
        import sumolib
        net = sumolib.net.readNet(str(tmp/'base.net.xml'))
        for e in CHAIN+[WORKS, DETOUR_FIRST]:
            net.getEdge(e)  # fails here if a link id does not match
        if len(net.getEdge(WORKS).getLanes()) != 2:
            raise RuntimeError('Works link must have two lanes')
        chain = works_chain(net)
        flows = json.loads((roads_dir()/'flows.json').read_text())
        wd, method = flows['days']['wd'], flows['method']
        counted = [e.getID() for e in net.getEdges() if e.getID() in wd]
        c = ET.Element('data'); iv = ET.SubElement(c, 'interval', id='wd08', begin='0', end='3600')
        for eid in counted:
            ET.SubElement(iv, 'edge', id=eid, entered='%.1f' % wd[eid][HOUR])
        xml(tmp/'counts.xml', c)
        py = sys.executable
        command([py, tools/'randomTrips.py','-n','base.net.xml','-o','cand.trips.xml','-r','cand.rou.xml','-b',0,'-e',4000,'-p',.2,
                 '--fringe-factor',20,'--min-distance',150,'--seed',7,'--validate'], tmp, 900)
        command([py, tools/'routeSampler.py','-r','cand.rou.xml','--edgedata-files','counts.xml','-o','sampled.rou.xml','--optimize','full',
                 '--seed',7,'--prefix','r','--write-flows','poisson','-b',0,'-e',3600,'--mismatch-output','mismatch.xml'], tmp, 900)
        routes = []
        for f in ET.parse(tmp/'sampled.rou.xml').getroot().iter('flow'):
            per = f.get('period', '')
            if not per.startswith('exp('):
                raise RuntimeError('Unexpected routeSampler flow '+ET.tostring(f, encoding='unicode')[:200])
            routes.append({'edges':f.find('route').get('edges').split(),'rate_s':float(per[4:-1])})
        paths = {}
        def detour(edges):
            if DETOUR_TURN not in edges: return None
            i = edges.index(DETOUR_TURN)
            if WORKS not in edges[i:]: return None
            dest = DEST_FIX.get(edges[-1], edges[-1])
            if dest not in paths:
                p, _ = net.getShortestPath(net.getEdge(DETOUR_FIRST), net.getEdge(dest))
                paths[dest] = [e.getID() for e in p] if p else None
            tail = paths[dest]
            return edges[:i+1]+tail if tail and WORKS not in tail else None
        for r in routes:
            r['through_works'] = WORKS in r['edges']
            r['detour'] = detour(r['edges'])
            r['to_works'] = to_works(net, r['edges'])
        length = {e.getID(): round(e.getLength(), 2) for e in net.getEdges()}
        dump(tmp/'demand.json', {'routes':routes,'counted_edges':len(counted),'edges':len(net.getEdges()),
             'measured_edges':sum(method.get(e) in ('detector_map','site_split') for e in counted),
             'nodes':nodes,'links':links,'veh_per_h':round(sum(r['rate_s'] for r in routes)*3600),
             'works_veh_per_h':round(sum(r['rate_s'] for r in routes if r['through_works'])*3600),
             'works_count_veh_per_h':wd.get(WORKS, [None]*24)[HOUR],
             'chain':chain,'length':length})
        cache.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.rename(tmp, cache)
        except OSError:
            if not (cache/'demand.json').exists(): raise
            shutil.rmtree(tmp, ignore_errors=True)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return cache


def vehicles(routes, seed):
    """Poisson arrivals on each route over [0, END) (simulation time, 0 = 07:57); with the same seed every scenario gets the same vehicles and the same diversion draw (common random numbers)."""
    rng = random.Random(seed)
    rows = []
    for k, r in enumerate(routes):
        t = rng.expovariate(r['rate_s'])
        while t < END:
            rows.append((round(t, 2), k)); t += rng.expovariate(r['rate_s'])
    rows.sort()
    draw = random.Random(seed*2654435761 % 2**32+1)
    return [{'id':'v%05d' % i,'depart':t,'route':k,'u':draw.random()} for i, (t, k) in enumerate(rows)]


def assign(rows, routes, share):
    """The route each vehicle actually takes: an eligible vehicle (route on Lonsdale westbound before Russell, passing through the works) takes the detour if its draw < the share."""
    out = []
    for v in rows:
        r = routes[v['route']]
        diverted = bool(r['detour']) and v['u'] < share
        out.append((v, r['detour'] if diverted else r['edges'], diverted, bool(r['detour'])))
    return out


def write_routes(folder, plan):
    root = ET.Element('routes')
    ET.SubElement(root, 'vType', id='car', vClass='passenger', length=str(CAR[0]), width=str(CAR[1]), minGap='2.5')
    for v, edges, _, _ in plan:
        e = ET.SubElement(root, 'vehicle', id=v['id'], type='car', depart='%.2f' % v['depart'], departLane='best', departSpeed='max')
        ET.SubElement(e, 'route', edges=' '.join(edges))
    xml(folder/'routes.rou.xml', root)


def write_additional(folder, closed):
    """One instantaneous induction loop on each of the two lanes at the end of the works (records each vehicle's passing time); scenarios with works also close the median-side lane at 08:00 (rerouter) and limit the remaining lane to 30 km/h (speed sign)."""
    root = ET.Element('additional')
    for i in (0, 1):
        ET.SubElement(root, 'instantInductionLoop', id='works_out_%d' % i, lane='%s_%d' % (WORKS, i), pos='-1', file='works_out.xml')
    if closed:
        r = ET.SubElement(root, 'rerouter', id='works_closure', edges=WORKS)
        iv = ET.SubElement(r, 'interval', begin=str(PRE), end=str(END+3600))
        ET.SubElement(iv, 'closingLaneReroute', id=WORKS_LANE, disallow='all')
        s = ET.SubElement(root, 'variableSpeedSign', id='works_speed', lanes=WORKS+'_0')
        ET.SubElement(s, 'step', time=str(PRE), speed='%.2f' % WORKS_SPEED)
    xml(folder/'works.add.xml', root)


def sumo_args(bins, net, seed):
    return [bins['sumo'],'-n',str(net),'-r','routes.rou.xml','-a','works.add.xml','--seed',str(seed),'--begin','0','--end',str(END+1),
            '--step-length',str(STEP),'--time-to-teleport',str(TELEPORT_S),'--ignore-junction-blocker',str(JUNCTION_BLOCKER_S),
            '--collision.action','warn','--collision.check-junctions','true','--collision-output','collisions.xml',
            '--fcd-output','fcd.xml','--device.fcd.begin',str(PRE),'--device.fcd.period',str(SAMPLE),'--fcd-output.acceleration','true',
            '--fcd-output.attributes','x,y,angle,speed,pos,lane,acceleration','--tripinfo-output','trips.xml',
            '--tripinfo-output.write-unfinished','true','--tripinfo-output.write-undeparted','true','--statistic-output','statistics.xml',
            '--no-step-log','true','--duration-log.disable','true','--log','run.log']


def net_info(path):
    """Signal programs, signal heads (one per approach), works lane shape, link lengths."""
    root = ET.parse(path).getroot()
    programs = {}
    for tl in root.findall('tlLogic'):
        ph = [(float(p.get('duration')), p.get('state')) for p in tl.findall('phase')]
        programs[tl.get('id')] = {'offset':float(tl.get('offset', '0')),'phases':ph,'cycle':sum(d for d, _ in ph)}
    lanes = {}
    for e in root.findall('edge'):
        if e.get('function'): continue
        for l in e.findall('lane'):
            lanes[l.get('id')] = [[float(v) for v in p.split(',')[:2]] for p in l.get('shape').split()]
    groups = {}
    for c in root.findall('connection'):
        if c.get('tl') and not c.get('from').startswith(':'):
            g = groups.setdefault((c.get('tl'), c.get('from')), {'idx':set(),'lanes':set()})
            g['idx'].add(int(c.get('linkIndex'))); g['lanes'].add(c.get('from')+'_'+c.get('fromLane'))
    heads = []
    for (tl, edge), g in sorted(groups.items()):
        pts = [lanes[l][-1] for l in sorted(g['lanes'])]
        x, y = sum(p[0] for p in pts)/len(pts), sum(p[1] for p in pts)/len(pts)
        lon, lat = lonlat_e6(x, y)
        heads.append({'id':tl+'|'+edge,'tls':tl,'idx':sorted(g['idx']),'lon_e6':lon,'lat_e6':lat,'_uv':UV(x, y)})
    return programs, heads, lanes


def tls_state(p, t):
    x = (t-p['offset']) % p['cycle']
    for d, s in p['phases']:
        if x < d: return s
        x -= d
    return p['phases'][-1][1]


def queue_now(stopped, length=None):
    """Continuous queue length upstream from the start of the works, with gaps ≤ 60 m (the rule from the prototype run_scen.py)."""
    ext = prev = 0.0
    for d in sorted(stopped):
        if d-prev > QUEUE_GAP: break
        ext = prev = d
    return ext


def queue_count(dists):
    """Count vehicles with the same rule: how many are connected upstream from the start of the works with gaps ≤ 60 m."""
    return queue_parts([(d, 0) for d in dists])[0]


def queue_parts(items):
    """items = [(distance along the route to the works, 1 on the Lonsdale / Albert chain / 0 on a side street)]: how many are connected, and how many of those are on the chain."""
    n = c = 0; prev = 0.0
    for d, on_chain in sorted(items):
        if d-prev > QUEUE_GAP: break
        n += 1; c += on_chain; prev = d
    return n, c


def minute_series(ts, qs, es):
    """One entry per minute [minute, physical queue m, engine method m] over the last 90 s signal cycle up to that minute: the longest physical queue (back of queue) and the mean for the engine method."""
    out = []
    for m in range(SHOWN//60+1):
        hi = m*60; lo = bisect.bisect_right(ts, hi-CYCLE); j = bisect.bisect_right(ts, hi)
        lo = min(lo, j-1)
        out.append([m, round(max(qs[lo:j]), 1), round(sum(es[lo:j])/(j-lo)*VEH_M/LANES_M, 1)])
    return out


def run_job(spec):
    """One scenario: write routes → run SUMO → read the FCD into replay chunks and metrics. Runs in its own process (build() runs several scenarios in parallel subprocesses)."""
    t0 = time.time()
    k, folder, out = spec['scenario'], Path(spec['folder']), Path(spec['out'])
    cache = Path(spec['cache'])
    demand = json.loads((cache/'demand.json').read_text())
    routes = demand['routes']
    rows = vehicles(routes, spec['seed'])
    plan = assign(rows, routes, spec['share'])
    write_routes(folder, plan); write_additional(folder, spec['closed'])
    args = sumo_args(spec['bins'], cache/'base.net.xml', spec['seed'])
    (folder/'command.json').write_text(json.dumps([str(a) for a in args[1:]], indent=1)+'\n')
    command(args, folder, 3600)
    t_sumo = time.time()
    result = export(folder, out, k, cache/'base.net.xml', demand, plan, spec['closed'], spec['frames'])
    result['wall'] = {'sumo_s':round(t_sumo-t0, 2),'export_s':round(time.time()-t_sumo, 2)}
    dump(folder/'result.json', result)


def export(folder, out, scenario, net_path, demand, plan, closed, write_frames):
    programs, heads, lanes = net_info(net_path)
    length = demand['length']
    chain = dict(demand['chain'])
    heads = [h for h in heads if in_box(VIEW_BOX, *h['_uv'])]
    shown_tls = sorted({h['tls'] for h in heads})
    for h in heads: del h['_uv']
    routes = demand['routes']
    info = {}  # vehicle → (distance-to-works table or None)
    for v, edges, diverted, _ in plan:
        info[v['id']] = None if diverted else routes[v['route']]['to_works']
    catalog, index, seen = [], {}, set()
    frames, chunks, size = [], [], 0
    ts, qs, es, ec = [], [], [], []
    n_min = SHOWN//60
    halting, harsh = [0.0]*n_min, [0]*n_min
    braking, last_edge = set(), {}
    def flush():
        nonlocal size
        if not frames: return
        name = 'frames-%03d.json' % len(chunks)
        dump(out/name, {'frames':frames})
        data = (out/name).read_bytes()
        chunks.append({'file':name,'start':frames[0]['t'],'end':frames[-1]['t'],'frames':len(frames),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        frames.clear(); size = 0
    for _, ts_el in ET.iterparse(folder/'fcd.xml', events=['end']):
        if ts_el.tag != 'timestep': continue
        sim_t = float(ts_el.get('time')); t = int(round(sim_t))-PRE
        if t < 0 or t > SHOWN:
            ts_el.clear(); continue
        agents, stopped, queued, halt, now_braking = [], [], [], 0, set()
        shown = t < SHOWN
        for a in ts_el:
            if a.tag != 'vehicle': continue
            vid = a.get('id')
            x, y, ang, v = float(a.get('x')), float(a.get('y')), float(a.get('angle')), float(a.get('speed'))
            lane = a.get('lane', ''); edge = lane.rsplit('_', 1)[0]; internal = edge.startswith(':')
            if not internal: last_edge[vid] = edge
            cx, cy = centre(x, y, ang, CAR[0])
            if shown and in_box(VIEW_BOX, *UV(cx, cy)):
                seen.add(vid)
                if v < HALT_SPEED: halt += 1
                if float(a.get('acceleration', '0')) <= HARSH_DECEL:
                    now_braking.add(vid)
                    if vid not in braking: harsh[t//60] += 1
                if write_frames:
                    if vid not in index:
                        index[vid] = len(catalog); catalog.append({'id':vid,'type':'car','length_m':CAR[0],'width_m':CAR[1]})
                    lon, lat = lonlat_e6(cx, cy)
                    agents.append([index[vid], lon, lat, round(ang) % 360, round(v*100)])
            if v >= QUEUE_SPEED: continue
            pos = float(a.get('pos'))
            # physical queue: stopped vehicles on the Lonsdale / Albert St westbound chain
            if edge == WORKS: stopped.append(0.0)
            elif edge in chain: stopped.append(chain[edge]+length[edge]-pos)
            # engine method: vehicles that still have to pass through the works (the works lie ahead on their route), by distance along the route to the works
            tw = info.get(vid)
            if tw is None: continue
            if edge == WORKS: queued.append((0.0, 1))
            elif not internal and edge in tw: queued.append((tw[edge]+length[edge]-pos, int(edge in chain)))
            elif internal and last_edge.get(vid) in tw: queued.append((tw[last_edge[vid]], int(last_edge[vid] in chain)))
        braking = now_braking
        q = round(queue_now(stopped), 1)
        n_all, n_chain = queue_parts(queued)
        ts.append(t); qs.append(q); es.append(n_all); ec.append(n_chain)
        if shown:
            halting[t//60] += halt*SAMPLE/60
            if write_frames:
                frames.append({'t':t,'a':agents,'tls':{k:tls_state(programs[k], sim_t-STEP) for k in shown_tls},'q':q})
                size += 40*len(agents)+30*len(shown_tls)+40
                if len(frames) >= CHUNK_FRAMES or size > CHUNK_BYTES: flush()
        ts_el.clear()
    flush()
    if ts != list(range(0, SHOWN+1, SAMPLE)):
        raise RuntimeError('FCD covers %d of %d samples' % (len(ts), SHOWN//SAMPLE+1))
    # vehicles not yet in the network (insertion blocked): those bound through the works also count in the engine-method queue
    trips = {}
    for r in ET.parse(folder/'trips.xml').getroot().iter('tripinfo'):
        trips[r.get('id')] = r
    waiting_all, pend = [], []
    for v, edges, diverted, _ in plan:
        r = trips.get(v['id'])
        dep = float(r.get('depart', '-1')) if r is not None else -1.0
        dep = dep if dep >= 0 else math.inf
        if dep > v['depart']+STEP:
            waiting_all.append((v['depart'], dep))
            if info.get(v['id']) is not None: pend.append((v['depart'], dep))
    starts, ends = sorted(a for a, _ in pend), sorted(b for _, b in pend)
    ep = [bisect.bisect_right(starts, t+PRE)-bisect.bisect_right(ends, t+PRE) for t in ts]
    es = [a+b for a, b in zip(es, ep)]
    series = minute_series(ts, qs, es)
    # breakdown of the 09:00 figure (mean vehicles over the last cycle): queued on the Lonsdale / Albert westbound chain, spilled back onto side streets, not yet able to enter the network
    lo = bisect.bisect_right(ts, SHOWN-CYCLE); mean = lambda xs: round(sum(xs[lo:])/(len(ts)-lo), 1)
    parts = {'lonsdale_albert':mean(ec),'side_streets':mean([a-b-c for a, b, c in zip(es, ec, ep)]),'waiting_to_enter':mean(ep)}
    backlog_end = sum(1 for a, b in waiting_all if a <= END < b)
    tele_log = teleports(folder, info)
    # loop at the end of the works: the first time each vehicle passes
    passed = {}
    wo = folder/'works_out.xml'
    if wo.exists():
        for e in ET.parse(wo).getroot().iter('instantOut'):
            if e.get('state') in ('enter', 'stay'):
                passed.setdefault(e.get('vehID'), float(e.get('time')))
    throughput = sum(1 for tt in passed.values() if PRE <= tt < END)
    stats = ET.parse(folder/'statistics.xml').getroot()
    safety, tele = stats.find('safety'), stats.find('teleports')
    # A collision on a lane = failure; "collisions" inside junctions are reported separately: the internal lane geometry of merged OSM junctions overlaps (by default SUMO does not check junctions at all),
    # and warn only records them without changing the dynamics; vehicles released by ignore-junction-blocker passing through a vehicle that blocks the junction are also recorded here, so both are reported honestly in metrics
    kinds = [c.get('type') for c in ET.parse(folder/'collisions.xml').getroot().findall('collision')]
    junction = sum(1 for k in kinds if k == 'junction')
    collisions = max(len(kinds)-junction, int(safety.get('collisions'))-junction)
    loss, completed = {}, 0
    for vid, r in trips.items():
        loss[vid] = float(r.get('timeLoss', '0'))+float(r.get('departDelay', '0'))
        if float(r.get('arrival', '-1')) >= PRE: completed += 1
    cohort = [v['id'] for v, _, _, _ in plan if PRE <= v['depart'] < END]
    in_cohort = set(cohort)
    works_shape = [list(lonlat_e6(x, y)) for x, y in lanes.get(WORKS_LANE, [])]
    manifest = {'version':2,'network':'real','scenario':scenario,'duration_s':SHOWN,'sample_s':SAMPLE,'clock0_s':0,
        'agent_columns':['i','lon_e6','lat_e6','angle_deg','speed_cms'],'agents':catalog,'signal_heads':heads,'chunks':chunks,
        'works':{'link':WORKS,'closed_lane':WORKS_LANE if closed else None,'lane_shape_e6':works_shape,
                 'closed_from_s':0 if closed else None},
        'metrics':{'vehicles':len(seen),'completed':completed,'teleports':int(tele.get('total')),'collisions':collisions,'junction_collisions':junction,
                   'emergency_braking':int(safety.get('emergencyBraking')),
                   'mean_timeloss_s':round(sum(loss.get(v, 0.0) for v in cohort)/len(cohort), 1) if cohort else None,'mean_extra_s':None,
                   'works_queue_max_m':max(qs[:-1]),'works_queue_mean_m':round(sum(qs[:-1])/(len(qs)-1), 1),
                   'works_queue_end_m':series[-1][1],'works_queue_equiv_end_m':series[-1][2],
                   'works_queue_equiv_max_m':max(s[2] for s in series),'works_queue_equiv_end_vehicles':parts,
                   'queue_series':series,
                   'works_throughput_vph':throughput,'works_capacity_assumption_vph':ENGINE_CAPACITY_VPH,
                   'works_demand_vph':sum(1 for v, _, _, _ in plan if v['id'] in in_cohort and info.get(v['id']) is not None),
                   'insertion_backlog_end':backlog_end,'teleports_in_hour':tele_log['in_hour'],'teleports_works_bound':tele_log['works_bound'],
                   'teleport_edges':tele_log['edges'],
                   'detour_vehicles':sum(1 for v, _, d, _ in plan if d and v['id'] in in_cohort),
                   'eligible_vehicles':sum(1 for v, _, _, el in plan if el and v['id'] in in_cohort),
                   'cohort_vehicles':len(cohort)},
        'per_minute':{'halting':[round(h, 1) for h in halting],'harsh':harsh}}
    return {'manifest':manifest,'loss':{v: loss.get(v, 0.0) for v in cohort},'passed':passed,
            'bound':sorted(v for v, tw in info.items() if tw is not None)}


def teleports(folder, info):
    """Every teleport in run.log: the count in 08:00–09:00, how many of those were works-route vehicles that had not yet passed the works (which shortens the queue), and the top 5 links."""
    rows = []
    for line in (folder/'run.log').read_text(encoding='utf-8', errors='replace').splitlines():
        m = re.search(r"Teleporting vehicle '([^']+)';.*?lane='([^']*)'.*?time=([0-9]+(?:\.[0-9]+)?)", line)
        if m: rows.append((m.group(1), m.group(2).rsplit('_', 1)[0], float(m.group(3))))
    hour = [r for r in rows if PRE <= r[2] <= END]
    wb = [r for r in hour if info.get(r[0]) is not None and (r[1] == WORKS or r[1] in info[r[0]])]
    edges = {}
    for _, e, _ in hour: edges[e] = edges.get(e, 0)+1
    return {'in_hour':len(hour),'works_bound':len(wb),'edges':sorted(edges.items(), key=lambda x: (-x[1], x[0]))[:5]}


def delayed_vs_baseline(passed_k, passed_b, bound):
    """For the same vehicles (those bound through the works in this scenario), the number that by 09:00 had passed the works in the no-works run but not here — the queued vehicles of the engine's D/D/1 model."""
    n = 0
    for v in bound:
        b, k = passed_b.get(v, math.inf), passed_k.get(v, math.inf)
        if b < END and not k < END: n += 1
        elif k < END and not b < END: n -= 1
    return n


DEFAULT_KEYS = set(DEFAULTS)


def validate_real(payload):
    if not isinstance(payload, dict):
        raise ValueError('Payload must be an object')
    payload = dict(payload)
    if payload.pop('network', 'real') != 'real':
        raise ValueError('network must be "real"')
    if 'options' in payload: return validate_options(payload)  # options mode: a diversion share per option
    extra = set(payload)-DEFAULT_KEYS
    if extra:
        raise ValueError('Unknown field: '+', '.join(sorted(extra)))
    config = {**DEFAULTS, **payload}
    s = config['seed']
    if type(s) is not int or not 0 <= s <= 2147483647:
        raise ValueError('seed must be an integer in [0, 2147483647]')
    for k in ['p_original','p_ai']:
        p = config[k]
        if type(p) not in (int, float) or not math.isfinite(p) or not 0 <= p <= 1:
            raise ValueError(k+' must be a number in [0, 1]')
        config[k] = float(p)
    sc = config['scenarios']
    if not isinstance(sc, list) or not sc or any(not isinstance(x, str) or x not in SCENARIOS for x in sc) or len(set(sc)) != len(sc):
        raise ValueError('scenarios must be a nonempty list of unique ids from baseline, original, ai')
    config['scenarios'] = [x for x in SCENARIOS if x in sc]
    return config


# ---- Options mode: each option (A–E) has its own diversion share p → one scenario opt-<id> each (one lane closed as in original / ai; only p differs) ----
OPTION_IDS = ('A','B','C','D','E')
OPTION_KEYS = {'seed','options','frames'}


def validate_options(payload):
    """{seed?, options:[{id:'A'…'E', p:0…1}] (1–5, unique ids), frames?:false} → config;
    scenarios = baseline + opt-<id> (sorted by id). Cannot be combined with p_original / p_ai / scenarios."""
    extra = set(payload)-OPTION_KEYS
    if extra:
        raise ValueError('Unknown field with options: '+', '.join(sorted(extra)))
    s = payload.get('seed', DEFAULTS['seed'])
    if type(s) is not int or not 0 <= s <= 2147483647:
        raise ValueError('seed must be an integer in [0, 2147483647]')
    opts = payload['options']
    if not isinstance(opts, list) or not 1 <= len(opts) <= len(OPTION_IDS):
        raise ValueError('options must be a list of 1–5 {id, p}')
    out = []
    for o in opts:
        if not isinstance(o, dict) or set(o) != {'id','p'} or not isinstance(o['id'], str) or o['id'] not in OPTION_IDS:
            raise ValueError('each option must be {id: A–E, p: number in [0, 1]}')
        p = o['p']
        if type(p) not in (int, float) or not math.isfinite(p) or not 0 <= p <= 1:
            raise ValueError('option '+o['id']+': p must be a number in [0, 1]')
        out.append({'id':o['id'],'p':float(p)})
    if len({o['id'] for o in out}) != len(out):
        raise ValueError('option ids must be unique')
    frames = payload.get('frames', False)
    if type(frames) is not bool:
        raise ValueError('frames must be true or false')
    out.sort(key=lambda o: o['id'])
    return {'seed':s,'options':out,'frames':frames,'scenarios':['baseline']+['opt-'+o['id'] for o in out]}


def run_config(args):
    """Input for build(args): with options, options mode; otherwise seed / p_original / p_ai / scenarios as before."""
    if getattr(args, 'options', None) is not None:
        return {k: getattr(args, k) for k in OPTION_KEYS if getattr(args, k, None) is not None}
    return {k: getattr(args, k) for k in DEFAULTS}


def scenario_plan(config):
    """→ ({scenario: diversion share}, {scenario: write frames or not}, {reused scenario: the one actually run}).
    The original three scenarios follow SCENARIOS (only original / ai write frames); in options mode baseline produces metrics only and opt-<id> follows frames (off by default).
    With the same seed every scenario has the same vehicles and the same draws, so equal p gives identical results: only the first one runs and the rest copy it."""
    if 'options' not in config:
        shares = {'baseline':0.0,'original':config['p_original'],'ai':config['p_ai']}
        return shares, {k: SCENARIOS[k]['frames'] for k in shares}, {}
    shares, frames, first, reuse = {'baseline':0.0}, {'baseline':False}, {}, {}
    for o in config['options']:
        k = 'opt-'+o['id']; shares[k] = o['p']; frames[k] = config['frames']
        if o['p'] in first: reuse[k] = first[o['p']]
        else: first[o['p']] = k
    return shares, frames, reuse


def closed(k):
    return SCENARIOS[k]['closed'] if k in SCENARIOS else k.startswith('opt-')


def label(k):
    s = SCENARIOS.get(k) or {'en':'Option '+k[4:],'zh':'方案 '+k[4:]}
    return {'en':s['en'],'zh':s['zh']}


def copy_reused(out, reuse, results):
    """Options with the same p copy the result of the one actually run (deep copy; frames-NNN.json files are copied too when present, sha256 unchanged); the manifest is marked reused_from."""
    for k, src in reuse.items():
        r = json.loads(json.dumps(results[src]))
        r['manifest']['scenario'] = k; r['manifest']['reused_from'] = src
        if r['manifest']['chunks']: shutil.copytree(out/src, out/k)
        results[k] = r


def build(args):
    t_start = time.time()
    config = validate_real(run_config(args))
    bins, version, tools = binaries()
    work = Path(args.work_dir or tempfile.mkdtemp(prefix='rippletwin-sumo-real-')).resolve(); work.mkdir(parents=True, exist_ok=True)
    out = Path(args.output).resolve(); out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        raise ValueError('Output directory must be empty')
    green = getattr(args, 'green_2935', None) or GREEN_2935
    if not .3 <= green <= .95:
        raise ValueError('green_2935 must be in [0.3, 0.95]')
    cache = prepare(bins, version, tools, green)
    t_prep = time.time()
    demand = json.loads((cache/'demand.json').read_text())
    shares, frames, reuse = scenario_plan(config)  # the original three scenarios / options-mode opt-<id>; options with the same p run only once
    jobs = max(1, int(os.environ.get('SUMO_REAL_JOBS') or min(3, os.cpu_count() or 1)))
    pending = [k for k in config['scenarios'] if k not in reuse]; walls = {}; procs = {}
    while pending or procs:
        while pending and len(procs) < jobs:
            k = pending.pop(0); folder = work/k
            if folder.exists(): shutil.rmtree(folder)
            folder.mkdir(parents=True)
            spec = {'scenario':k,'folder':str(folder),'out':str(out/k),'cache':str(cache),'seed':config['seed'],'share':shares[k],'bins':bins,
                    'closed':closed(k),'frames':frames[k]}
            (folder/'job.json').write_text(json.dumps(spec, indent=1)+'\n')
            log = open(folder/'stdout.log', 'w')
            # one subprocess per scenario: SUMO and FCD parsing both run inside it, so scenarios truly run in parallel (Python parsing is CPU-bound; threads would not help)
            procs[k] = (subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--job', str(folder/'job.json')], cwd=folder,
                                         stdout=log, stderr=subprocess.STDOUT), time.time(), log)
        for k, (p, t0, log) in list(procs.items()):
            try:
                rc = p.wait(timeout=.1)
            except subprocess.TimeoutExpired:
                if time.time()-t0 > 1800:  # a scenario normally takes 10–60 s; if one hangs, stop them all and leave no orphan processes
                    for q, _, lg in procs.values(): q.kill(); lg.close()
                    raise RuntimeError('SUMO timed out: '+k)
                continue
            log.close(); del procs[k]; walls[k] = round(time.time()-t0, 2)
            if rc:
                for q, _, lg in procs.values(): q.kill(); lg.close()
                tail = lambda f: (work/k/f).read_text()[-4000:] if (work/k/f).exists() else ''
                raise RuntimeError('SUMO failed ('+k+'):\n'+tail('stdout.log')+tail('run.log'))
    results = {k: json.loads((work/k/'result.json').read_text()) for k in config['scenarios'] if k not in reuse}
    job_s = {k: r['wall'] for k, r in results.items()}
    copy_reused(out, reuse, results)
    results = {k: results[k] for k in config['scenarios']}
    manifests = {k: r['manifest'] for k, r in results.items()}
    for k, m in manifests.items():
        if m['metrics']['collisions']:
            raise RuntimeError('SUMO reported %d collision(s) in %s' % (m['metrics']['collisions'], k))
    base = results.get('baseline')
    through = {v['id'] for v in vehicles(demand['routes'], config['seed']) if demand['routes'][v['route']]['through_works']}
    for k, m in manifests.items():
        mt = m['metrics']
        mt['works_traffic_extra_s'] = None; mt['works_queue_vs_baseline_end_m'] = None
        if base is not None and k != 'baseline':
            bl, kl = base['loss'], results[k]['loss']
            ids = [v for v in bl if v in kl]
            mt['mean_extra_s'] = round(sum(kl[v]-bl[v] for v in ids)/len(ids), 1) if ids else None
            # vehicles whose original route passes through the works (including those that detour): these are the ones the sign addresses
            w = [v for v in ids if v in through]
            mt['works_traffic_extra_s'] = round(sum(kl[v]-bl[v] for v in w)/len(w), 1) if w else None
            # baseline-comparison method: the same vehicles that by 09:00 had passed the works without works but not with works → D/D/1 queued vehicles × 7 m ÷ 2
            n = delayed_vs_baseline(results[k]['passed'], base['passed'], results[k]['bound'])
            mt['works_queue_vs_baseline_end_m'] = round(n*VEH_M/LANES_M, 1)
        m.update(engine=version, seed=config['seed'], diversion_share=shares[k])
        dump(out/k/'manifest.json', m)
    source = os.environ.get('SUMO_REAL_SOURCE') or ('local-macos-arm64' if sys.platform == 'darwin' and platform.machine() == 'arm64' else sys.platform+'-'+platform.machine())
    index = {'version':2,'network':'real','engine':version,'generator_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'seed':config['seed'],'hour':HOUR,'works':{'link':WORKS,'lanes_closed':1},
        'params':{**config,'source':source,'hour_window':[HOUR, HOUR+1],'warmup_s':PRE,'warmup_before_clock0':True,'shown_s':SHOWN,
                  'sim_s':END,'sample_s':SAMPLE,'step_s':STEP,'cycle_s':CYCLE,'signal_2935_green':green,'green_2935':green,
                  'works_lane_speed_kmh':round(WORKS_SPEED*3.6),'works_closed_from':'%02d:00:00' % HOUR,
                  'engine_capacity_vph':ENGINE_CAPACITY_VPH,'time_to_teleport_s':TELEPORT_S,'ignore_junction_blocker_s':JUNCTION_BLOCKER_S,
                  'demand':'flows.json wd hour %d' % HOUR,'demand_veh_per_h':demand['veh_per_h'],
                  'works_demand_veh_per_h':demand['works_veh_per_h'],'works_count_veh_per_h':demand['works_count_veh_per_h'],
                  'routes':len(demand['routes']),'network_nodes':demand['nodes'],'network_links':demand['links'],
                  'counted_edges':demand['counted_edges'],'measured_edges':demand['measured_edges'],'net_edges':demand['edges'],
                  'chain_m':round(demand['chain'][-1][1]+demand['length'][demand['chain'][-1][0]]),
                  'network_extent':NETWORK_EXTENT['en'],'network_extent_zh':NETWORK_EXTENT['zh'],
                  'view_box_uv_m':list(VIEW_BOX),'study_area':NETWORK_EXTENT['en']},
        'assumptions':{k:[x.replace('{green}', str(round(green*100))).replace('{extent}', NETWORK_EXTENT[k]) for x in v] for k, v in ASSUMPTIONS.items()},
        'scenarios':[{'id':k,'label':label(k),'diversion_share':shares[k],
                      'manifest':k+'/manifest.json','metrics':manifests[k]['metrics'],**({'reused_from':reuse[k]} if k in reuse else {})}
                     for k in config['scenarios']],
        'timing':{'prepare_s':round(t_prep-t_start, 2),'sumo_s':walls,'job_s':job_s,
                  'total_s':round(time.time()-t_start, 2),'jobs':jobs}}
    dump(out/'index.json', index)
    print('Raw audit:', work, '\nReplay:', out, '\nTotal %.1f s' % index['timing']['total_s'], flush=True)
    return index


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--seed', type=int, default=DEFAULTS['seed'])
    parser.add_argument('--p-original', type=float, default=DEFAULTS['p_original'])
    parser.add_argument('--p-ai', type=float, default=DEFAULTS['p_ai'])
    parser.add_argument('--scenarios', nargs='+', choices=list(SCENARIOS), default=list(SCENARIOS))
    parser.add_argument('--output')
    parser.add_argument('--work-dir')
    parser.add_argument('--green-2935', type=float, default=GREEN_2935, help='Share of the cycle (green + amber) the 2935 pedestrian signal gives Lonsdale traffic (for baking / sensitivity runs only; not exposed in the API)')
    parser.add_argument('--prepare-only', action='store_true', help='Only build the cache (network + demand); used to warm it during the image build')
    parser.add_argument('--options', nargs='+', metavar='ID=P', help='Options mode, e.g. A=0.14 B=0.14 C=0.607 → baseline + opt-A/B/C (ignores --p-original / --p-ai / --scenarios)')
    parser.add_argument('--frames', action='store_true', help='In options mode, also write per-frame files for opt-<id> (default: metrics only)')
    parser.add_argument('--job', help=argparse.SUPPRESS)  # used internally by build(): runs one scenario
    args = parser.parse_args()
    if args.options is not None:
        try: args.options = [{'id':x.split('=', 1)[0],'p':float(x.split('=', 1)[1])} for x in args.options]
        except (IndexError, ValueError): parser.error('--options takes ID=P pairs, e.g. A=0.14')
    if args.job:
        run_job(json.loads(Path(args.job).read_text()))
        sys.exit(0)
    if args.prepare_only:
        print(prepare(*binaries(), args.green_2935))
        sys.exit(0)
    if not args.output:
        parser.error('--output is required')
    for k, v in validate_real(run_config(args)).items(): setattr(args, k, v)
    build(args)
