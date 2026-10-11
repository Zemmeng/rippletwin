"""SUMO backend unit/API contract tests; native executable is not required in CI."""
import contextlib
import io
import json
import pathlib
import sys
import tempfile
import threading
import unittest
import urllib.request
from types import SimpleNamespace
from unittest import mock

TOOLS=pathlib.Path(__file__).resolve().parents[1]/'tools/sumo'
sys.path.insert(0,str(TOOLS))
import build_demo as model
import serve


def fixture(args):
    out=pathlib.Path(args.output)
    model.dump(out/'index.json',{'version':1,'config':{k:getattr(args,k) for k in model.DEFAULT_CONFIG}})
    model.dump(out/'baseline/manifest.json',{
        'duration_s':3,'agents':[{'id':'bus-1','kind':'bus','length':12,'width':2.5}],
        'geometry':{'lanes':[{'id':'A_B_1'}]},
        'chunks':[{'file':'frames-000.json','start':0,'end':2}]})
    model.dump(out/'baseline/frames-000.json',{'frames':[
        {'t':t,'a':[[0,12345,-240,90,500,0]],'q':[[0,25]],'signals':{'A':'Gr'},'counts':{'running':1}}
        for t in range(3)]})


def raw_then(fail):
    def runner(args):
        raw=pathlib.Path(args.work_dir);(raw/'closure').mkdir(parents=True)
        (raw/'closure/queues.xml').write_bytes(b' '*1_500_000);(raw/'closure/trips.xml').write_text('<trips/>')
        (raw/'closure/run.log').write_text('log');fixture(args)
        if fail:raise RuntimeError('Simulation integrity failure closure')
    return runner


REAL_IDS=('baseline','original','ai')


def fake_validate_real(payload):
    # Stand-in written to interface spec F: allow-list + ranges; the real build_real.validate_real is checked directly by a separate test
    if not isinstance(payload,dict):raise ValueError('payload must be an object')
    extra=set(payload)-{'seed','p_original','p_ai','scenarios'}
    if extra:raise ValueError('unknown fields: '+', '.join(sorted(extra)))
    out={'seed':payload.get('seed',42),'p_original':payload.get('p_original',.14),'p_ai':payload.get('p_ai',.53),
         'scenarios':payload.get('scenarios',list(REAL_IDS))}
    if type(out['seed']) is not int or not 0<=out['seed']<=2147483647:raise ValueError('seed')
    for k in ('p_original','p_ai'):
        if type(out[k]) not in (int,float) or not 0<=out[k]<=1:raise ValueError(k)
    if not isinstance(out['scenarios'],list) or not out['scenarios'] or not set(out['scenarios'])<=set(REAL_IDS):raise ValueError('scenarios')
    return out


def fake_build_real(args):
    # Minimal directory per interface spec A: index.json + <id>/manifest.json + <id>/frames-000.json
    out=pathlib.Path(args.output)
    model.dump(out/'index.json',{'version':2,'network':'real','seed':args.seed,'hour':8,
        'params':{'seed':args.seed,'p_original':args.p_original,'p_ai':args.p_ai,'scenarios':args.scenarios},
        'scenarios':[{'id':i,'manifest':f'{i}/manifest.json','metrics':{}} for i in args.scenarios]})
    for i in args.scenarios:
        model.dump(out/i/'manifest.json',{'version':2,'network':'real','scenario':i,'duration_s':2,'sample_s':1,'clock0_s':180,
            'agent_columns':['i','lon_e6','lat_e6','angle_deg','speed_cms'],'agents':[{'id':'v0','type':'car','length_m':5,'width_m':1.8}],
            'signal_heads':[],'chunks':[{'file':'frames-000.json','start':0,'end':1,'sha256':None}],'metrics':{}})
        model.dump(out/i/'frames-000.json',{'frames':[{'t':t,'a':[[0,144963000,-37810000,90,500]],'tls':{},'q':0} for t in range(2)]})


def fake_build_options(args):
    # Minimal directory for options mode: index.json + manifest.json for baseline / opt-<id>; frames:false → empty chunks, no frames-NNN.json
    out=pathlib.Path(args.output)
    model.dump(out/'index.json',{'version':2,'network':'real','seed':args.seed,'hour':8,
        'params':{'seed':args.seed,'options':args.options,'frames':args.frames,'scenarios':args.scenarios},
        'scenarios':[{'id':i,'manifest':f'{i}/manifest.json','metrics':{'works_queue_max_m':1.0}} for i in args.scenarios]})
    for i in args.scenarios:
        chunks=[{'file':'frames-000.json','start':0,'end':1,'sha256':None}] if args.frames else []
        model.dump(out/i/'manifest.json',{'version':2,'network':'real','scenario':i,'duration_s':2,'chunks':chunks,'metrics':{'works_queue_max_m':1.0}})
        if args.frames:model.dump(out/i/'frames-000.json',{'frames':[{'t':t,'a':[],'tls':{},'q':0} for t in range(2)]})


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.jobs=serve.Jobs(self.temp.name,'SUMO test fixture',runner=fixture)

    def tearDown(self):
        self.jobs.close();serve.read_json.cache_clear();serve.read_file.cache_clear();self.temp.cleanup()

    def complete(self):
        job=self.jobs.create({})
        self.jobs.close()
        return self.jobs.get(job['id'])

    def test_demand_reproducible(self):
        self.assertEqual(model.demand(42),model.demand(42))
        self.assertNotEqual(model.demand(42),model.demand(43))
        self.assertEqual(len(model.demand(42)),759)

    def test_scale_and_duration_change_demand(self):
        self.assertLess(len(model.demand(42,60)),len(model.demand(42,600)))
        self.assertLess(len(model.demand(42,600,.5)),len(model.demand(42,600,1)))

    def test_four_junctions_are_connected(self):
        seen={'A'}
        for _ in range(len(model.NODES)):
            for a,b in model.PAIRS:
                if a in seen or b in seen:seen.update([a,b])
        self.assertEqual(set(model.NODES),seen)
        self.assertEqual(model.JUNCTIONS,list('ABCD'))

    def test_safety_validation_reads_engine_counters(self):
        root=pathlib.Path(self.temp.name)
        (root/'statistics.xml').write_text('<statistics><safety collisions="2" emergencyStops="1" emergencyBraking="3"/><teleports total="4"/></statistics>')
        checked=model.validation(root,{'collisions':1,'vehicles_unfinished':0,'pedestrians_unfinished':2},'Warning: person is jammed')
        self.assertEqual(checked,{'collisions':2,'teleports':4,'emergency_braking':3,'emergency_stops':1,'forced_pedestrian_escape':1,'all_arrived':False})

    def test_missing_safety_output_is_not_reported_as_zero(self):
        root=pathlib.Path(self.temp.name)
        (root/'statistics.xml').write_text('<statistics/>')
        with self.assertRaises(RuntimeError):model.validation(root,{},'')

    def test_config_rejects_unsupported_and_nonfinite_values(self):
        for config in [{'weather':'rain'},{'seed':True},{'seed':-1},{'seed':1.5},{'demand_scale':float('nan')},
                       {'diversion_share':float('inf')},{'demand_duration_s':601},{'scenarios':['no-such-scenario']},
                       {'scenarios':[]},{'scenarios':['closure','closure']},{'scenarios':'closure'},None,[]]:
            with self.subTest(config=config),self.assertRaises(ValueError):model.validate_config(config)

    def test_comparison_always_includes_baseline(self):
        c=model.validate_config({'scenarios':['guided']})
        self.assertEqual(c['scenarios'],['baseline','guided'])

    def test_create_status_and_completion(self):
        job=self.complete()
        self.assertEqual(job['status'],'complete')
        status,data=self.jobs.route('GET',job['result'])
        self.assertEqual(status,200);self.assertEqual(data['version'],1)
        self.assertEqual(data['config'],job['config'])

    def test_pending_job_cannot_publish_partial_results(self):
        event=threading.Event()
        self.jobs.runner=lambda args:event.wait(5)
        job=self.jobs.create({})
        try:
            with self.assertRaises(serve.ApiError) as e:self.jobs.output(job['id'])
            self.assertEqual(e.exception.status,409)
        finally:event.set()

    def test_failed_job_exposes_no_result(self):
        def broken(args):raise RuntimeError('test simulation failed')
        self.jobs.runner=broken
        job=self.complete()
        self.assertEqual(job['status'],'failed');self.assertNotIn('result',job)
        self.assertIn('test simulation failed',job['error'])

    def test_queue_is_bounded(self):
        event=threading.Event();self.jobs.limit=1
        self.jobs.runner=lambda args:event.wait(5)
        self.jobs.create({})
        try:
            with self.assertRaises(serve.ApiError) as e:self.jobs.create({})
            self.assertEqual(e.exception.status,429)
        finally:event.set()

    def test_frame_decodes_si_units_and_uses_actual_sample(self):
        job=self.complete();path=f"{serve.PREFIX}/runs/{job['id']}/frame?scenario=baseline&t=1.9"
        status,frame=self.jobs.route('GET',path)
        self.assertEqual(status,200);self.assertEqual(frame['time_s'],1)
        self.assertEqual(frame['requested_time_s'],1.9);self.assertFalse(frame['done'])
        agent=frame['agents'][0]
        self.assertEqual((agent['x_m'],agent['y_m'],agent['speed_mps']),(123.45,-2.4,5))
        self.assertEqual(agent['length_m'],12);self.assertEqual(agent['lane_id'],'A_B_1')
        self.assertEqual(frame['signals'],{'A':'Gr'})
        self.assertEqual(frame['queues'],[{'lane_id':'A_B_1','length_m':25}])

    def test_no_ghost_agents_after_completion(self):
        job=self.complete()
        frame=serve.frame_at(self.jobs.output(job['id']),'baseline',3)
        self.assertTrue(frame['done']);self.assertEqual(frame['agents'],[])

    def test_frame_rejects_bad_time_and_absent_scenario(self):
        job=self.complete();root=self.jobs.output(job['id'])
        for t in [-1,float('nan'),float('inf')]:
            with self.assertRaises(serve.ApiError):serve.frame_at(root,'baseline',t)
        with self.assertRaises(serve.ApiError) as e:serve.frame_at(root,'guided',0)
        self.assertEqual(e.exception.status,404)

    def test_path_traversal_cannot_read_raw_files(self):
        job=self.complete()
        for path in ['../raw/stdout.log','%2e%2e/job.json','baseline/../../job.json','job.json']:
            with self.assertRaises(serve.ApiError):self.jobs.route('GET',f"{serve.PREFIX}/runs/{job['id']}/{path}")

    def test_restart_marks_interrupted_job_failed(self):
        self.jobs.update({'id':'a'*32,'status':'running'})
        second=serve.Jobs(self.temp.name,'fixture',runner=fixture)
        try:self.assertEqual(second.get('a'*32)['status'],'failed')
        finally:second.close()

    def http(self,request,**server):
        class Socket:
            def __init__(self):self.output=bytearray()
            def makefile(self,*args):return io.BytesIO(request)
            def sendall(self,value):self.output.extend(value)
        class QuietHandler(serve.Handler):
            def log_message(self,*args):pass
        sock=Socket();QuietHandler(sock,('127.0.0.1',12345),SimpleNamespace(jobs=self.jobs,origins={'http://127.0.0.1:8001'},**server))
        return bytes(sock.output)

    def post(self,body=b'{}',headers=b'',**server):
        return self.http(b'POST /sumo/v1/runs HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: '+str(len(body)).encode()+b'\r\n'+headers+b'\r\n'+body,**server)

    def test_unapproved_origin_rejected_without_cors_grant(self):
        raw=self.http(b'POST /sumo/v1/runs HTTP/1.0\r\nOrigin: https://untrusted.example\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}')
        self.assertIn(b'403',raw.splitlines()[0]);self.assertNotIn(b'Access-Control-Allow-Origin',raw)
        self.assertEqual(self.jobs.active,0)

    def test_preflight_allows_only_explicit_origin(self):
        raw=self.http(b'OPTIONS /sumo/v1/runs HTTP/1.0\r\nOrigin: http://127.0.0.1:8001\r\n\r\n')
        self.assertIn(b'200',raw.splitlines()[0]);self.assertIn(b'Access-Control-Allow-Origin: http://127.0.0.1:8001',raw)

    def test_oversized_body_and_non_json_rejected(self):
        for header,code in [(b'Content-Type: application/json\r\nContent-Length: 20000',b'413'),
                            (b'Content-Type: text/plain\r\nContent-Length: 2',b'415')]:
            raw=self.http(b'POST /sumo/v1/runs HTTP/1.0\r\n'+header+b'\r\n\r\n{}')
            self.assertIn(code,raw.splitlines()[0])

    def test_invalid_json_rejected(self):
        raw=self.http(b'POST /sumo/v1/runs HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\nxx')
        self.assertIn(b'400',raw.splitlines()[0])


    def test_public_limits_match_measured_failures(self):
        for ok in [{'demand_scale':.1},{'demand_scale':1.2},{'clearance_s':600},{'clearance_s':2400}]:
            with self.subTest(ok=ok):model.validate_config(ok)
        for bad in [{'demand_scale':1.21},{'demand_scale':1.5},{'demand_scale':3},{'clearance_s':599},{'clearance_s':60},{'clearance_s':2401}]:
            with self.subTest(bad=bad),self.assertRaises(ValueError):model.validate_config(bad)
        raw=self.post(b'{"demand_scale":1.5}')
        self.assertIn(b'400',raw.splitlines()[0]);self.assertEqual(self.jobs.active,0)

    def test_version_check_skips_locale_warning(self):
        which=mock.patch.object(model.shutil,'which',lambda name:'/opt/sumo/bin/'+name)
        out="Warning: Could not set locale to 'C'.\nEclipse SUMO sumo 1.27.1\n Build features: Darwin arm64\n"
        with which,mock.patch.object(model,'command',return_value=out):
            self.assertEqual(model.binaries()[1],'Eclipse SUMO sumo 1.27.1')
        with which,mock.patch.object(model,'command',return_value="Warning: Could not set locale to 'C'.\nEclipse SUMO sumo 1.26.0\n"):
            with self.assertRaises(RuntimeError):model.binaries()

    def test_success_drops_raw_and_keeps_only_newest_runs(self):
        self.jobs.keep=2;self.jobs.runner=raw_then(False)
        ids=[self.jobs.create({})['id'] for _ in range(3)]
        self.jobs.close();root=pathlib.Path(self.temp.name)
        self.assertEqual(sorted(p.name for p in root.iterdir()),sorted(ids[1:]))
        for i in ids[1:]:
            self.assertEqual(self.jobs.get(i)['status'],'complete')
            self.assertFalse((root/i/'raw').exists());self.assertTrue((root/i/'output/index.json').exists())
        with self.assertRaises(serve.ApiError) as e:self.jobs.get(ids[0])
        self.assertEqual(e.exception.status,404)

    def test_failed_run_keeps_logs_but_drops_big_xml_and_partial_output(self):
        self.jobs.runner=raw_then(True)
        job=self.complete();root=pathlib.Path(self.temp.name)/job['id']
        self.assertEqual(job['status'],'failed')
        self.assertFalse((root/'raw/closure/queues.xml').exists());self.assertFalse((root/'output').exists())
        self.assertTrue((root/'raw/closure/trips.xml').exists());self.assertTrue((root/'raw/closure/run.log').exists())

    def test_restart_prunes_to_keep_runs(self):
        names=[f'{i:032x}' for i in range(3)]
        for name in names:self.jobs.update({'id':name,'status':'complete'})
        second=serve.Jobs(self.temp.name,'fixture',runner=fixture,keep=1)
        try:self.assertEqual([p.name for p in pathlib.Path(self.temp.name).iterdir()],names[-1:])
        finally:second.close()

    def test_sigterm_close_drops_queued_but_finishes_running(self):
        started,release,calls=threading.Event(),threading.Event(),[]
        def slow(args):calls.append(1);started.set();release.wait(5);fixture(args)
        self.jobs.runner=slow
        first,second=self.jobs.create({}),self.jobs.create({})
        self.assertTrue(started.wait(5))
        self.jobs.close(wait=False);release.set();self.jobs.close()
        self.assertEqual(len(calls),1)
        self.assertEqual(self.jobs.get(first['id'])['status'],'complete')
        again=serve.Jobs(self.temp.name,'fixture',runner=fixture)
        try:self.assertEqual(again.get(second['id'])['status'],'failed')
        finally:again.close()

    def test_head_sends_headers_only(self):
        head,_,body=self.http(b'HEAD /sumo/v1/health HTTP/1.0\r\n\r\n').partition(b'\r\n\r\n')
        full=self.http(b'GET /sumo/v1/health HTTP/1.0\r\n\r\n').partition(b'\r\n\r\n')[2]
        self.assertIn(b'200',head.splitlines()[0]);self.assertEqual(body,b'')
        self.assertIn(b'Content-Length: '+str(len(full)).encode(),head)

    def test_errors_use_repo_format(self):
        for raw,status,code in [(self.http(b'GET /sumo/v1/runs/'+b'a'*32+b' HTTP/1.0\r\n\r\n'),b'404','not_found'),
                                (self.post(b'{"weather":"rain"}'),b'400','bad_config'),
                                (self.post(b'x'*20000),b'413','too_big')]:
            with self.subTest(code=code):
                self.assertIn(status,raw.splitlines()[0])
                body=json.loads(raw.partition(b'\r\n\r\n')[2])
                self.assertEqual((body['ok'],body['error']),(False,code));self.assertTrue(body['msg'])

    def test_key_required_when_set_except_health(self):
        for headers,code in [(b'',b'401'),(b'X-Sumo-Key: wrong\r\n',b'401'),(b'X-Sumo-Key: \xff\r\n',b'401'),(b'X-Sumo-Key: s3cret\r\n',b'202')]:
            with self.subTest(headers=headers):self.assertIn(code,self.post(headers=headers,api_key='s3cret').splitlines()[0])
        self.assertIn(b'200',self.http(b'GET /sumo/v1/health HTTP/1.0\r\n\r\n',api_key='s3cret').splitlines()[0])
        self.assertIn(b'401',self.http(b'GET /sumo/v1/runs/'+b'a'*32+b' HTTP/1.0\r\n\r\n',api_key='s3cret').splitlines()[0])
        self.assertIn(b'202',self.post().splitlines()[0])

    def test_optional_per_ip_post_limit(self):
        self.jobs.limit=10;limit={'posts_per_min':2,'posts':{},'posts_lock':threading.Lock()}
        self.assertEqual([self.post(**limit).split()[1] for _ in range(3)],[b'202',b'202',b'429'])
        self.assertIn(b'"error":"sumo_rate"',self.post(**limit))
        self.assertIn(b'429',self.post(headers=b'X-Client-IP: 9.9.9.9\r\n',**limit).splitlines()[0])
        self.assertIn(b'202',self.post(headers=b'X-Sumo-Key: k\r\nX-Client-IP: 9.9.9.9\r\n',api_key='k',**limit).splitlines()[0])

    def test_settings_read_container_env_and_flags_win(self):
        a=serve.settings([],{'HOST':'0.0.0.0','PORT':'8080','SUMO_DATA_DIR':'/data','ALLOW_ORIGINS':'','SUMO_KEEP_RUNS':'20','SUMO_API_KEY':'k'})
        self.assertEqual((a.host,a.port,a.data_dir,a.allow_origin,a.keep_runs,a.posts_per_min,a.api_key),
                         ('0.0.0.0',8080,pathlib.Path('/data'),[],20,0,'k'))
        a=serve.settings(['--port','8041','--data-dir','/tmp/x','--allow-origin','http://a','--posts-per-min','3'],
                         {'SUMO_DATA_DIR':'/data','ALLOW_ORIGINS':'http://b, http://c'})
        self.assertEqual((a.host,a.port,a.data_dir,a.allow_origin,a.keep_runs,a.posts_per_min,a.api_key),
                         ('127.0.0.1',8041,pathlib.Path('/tmp/x'),['http://b','http://c','http://a'],20,3,''))
        for argv,env in [([],{}),([],{'SUMO_DATA_DIR':'/d','SUMO_KEEP_RUNS':'x'}),([],{'SUMO_DATA_DIR':'/d','SUMO_KEEP_RUNS':'0'}),
                         (['--data-dir','/d','--port','70000'],{}),(['--data-dir','/d','--posts-per-min','-1'],{})]:
            with self.subTest(argv=argv,env=env),self.assertRaises(SystemExit),contextlib.redirect_stderr(io.StringIO()):
                serve.settings(argv,env)

    # ---- Real network (interface spec v2 B/F): network:'real' goes to build_real, everything else unchanged ----
    def real_jobs(self,build=fake_build_real,validate=fake_validate_real):
        calls=[]
        def runner(args):calls.append(args);build(args)
        self.jobs.close();self.jobs=serve.Jobs(self.temp.name,'fixture',runner=fixture,real=SimpleNamespace(validate_real=validate,build=runner))
        return calls

    def run_real(self,payload):
        job=self.jobs.create(payload);self.jobs.close()
        return self.jobs.get(job['id'])

    def test_real_job_calls_build_real_with_contract_args(self):
        calls=self.real_jobs();synthetic=[];self.jobs.runner=lambda args:synthetic.append(args)
        job=self.run_real({'network':'real','seed':7,'p_ai':.6,'scenarios':['baseline','ai']})
        self.assertEqual(job['status'],'complete');self.assertEqual(synthetic,[])
        self.assertEqual(job['config'],{'network':'real','seed':7,'p_original':.14,'p_ai':.6,'scenarios':['baseline','ai']})
        args=calls[0];root=pathlib.Path(self.temp.name).resolve()/job['id']
        self.assertEqual(vars(args),{'seed':7,'p_original':.14,'p_ai':.6,'scenarios':['baseline','ai'],'output':root/'output','work_dir':root/'raw'})
        self.assertFalse((root/'raw').exists())

    def test_real_serves_contract_files_for_original_and_ai(self):
        self.real_jobs();job=self.run_real({'network':'real'})
        base=f"{serve.PREFIX}/runs/{job['id']}/"
        status,index=self.jobs.route('GET',job['result'])
        self.assertEqual((status,index['version'],index['network']),(200,2,'real'))
        self.assertEqual([s['id'] for s in index['scenarios']],list(REAL_IDS))
        for sid in REAL_IDS:
            with self.subTest(sid=sid):
                status,meta=self.jobs.route('GET',base+sid+'/manifest.json')
                self.assertEqual((status,meta['scenario']),(200,sid))
                status,chunk=self.jobs.route('GET',base+sid+'/'+meta['chunks'][0]['file'])
                self.assertEqual((status,chunk['frames'][0]['a'][0][1]),(200,144963000))
        for path in ['closure/manifest.json','original/frames-1.json','ai/../job.json','original/../../raw/x.json','frame?scenario=ai&t=0',
                     'frame?scenario=baseline&t=0','AI/manifest.json','original/manifest.json/']:
            with self.subTest(path=path),self.assertRaises(serve.ApiError) as e:self.jobs.route('GET',base+path)
            self.assertEqual(e.exception.status,404)

    def test_real_validation_errors_are_bad_config(self):
        calls=self.real_jobs()
        for payload in [{'network':'real','seed':-1},{'network':'real','p_ai':1.5},{'network':'real','scenarios':['closure']},
                        {'network':'real','weather':'rain'},{'network':'mars'},{'network':None},{'network':['real']},
                        {'network':'synthetic','p_ai':.5},{'network':'synthetic','weather':'rain'}]:
            with self.subTest(payload=payload),self.assertRaises(serve.ApiError) as e:self.jobs.create(payload)
            self.assertEqual((e.exception.status,e.exception.code),(400,'bad_config'))
        self.assertEqual((self.jobs.active,calls),(0,[]))
        raw=self.post(b'{"network":"real","p_original":-0.1}')
        self.assertIn(b'400',raw.splitlines()[0]);self.assertIn(b'"error":"bad_config"',raw)

    def test_synthetic_default_and_explicit_are_unchanged(self):
        self.real_jobs()
        self.assertEqual(self.jobs.configure({}),model.validate_config({}))
        self.assertEqual(self.jobs.configure({'network':'synthetic','seed':3}),model.validate_config({'seed':3}))
        self.assertNotIn('network',self.jobs.configure({'network':'synthetic'}))
        job=self.run_real({'network':'synthetic'})
        self.assertEqual(job['status'],'complete');self.assertNotIn('network',job['config'])
        status,frame=self.jobs.route('GET',f"{serve.PREFIX}/runs/{job['id']}/frame?scenario=baseline&t=0")
        self.assertEqual(status,200)

    def test_real_http_post_and_health_lists_networks(self):
        self.real_jobs()
        raw=self.post(b'{"network":"real","seed":1}')
        self.assertIn(b'202',raw.splitlines()[0])
        body=json.loads(raw.partition(b'\r\n\r\n')[2]);self.assertEqual(body['config']['network'],'real')
        health=json.loads(self.http(b'GET /sumo/v1/health HTTP/1.0\r\n\r\n').partition(b'\r\n\r\n')[2])
        self.assertEqual(health['networks'],['synthetic','real'])

    def test_real_backend_missing_is_500_and_synthetic_still_runs(self):
        def missing():raise ModuleNotFoundError("No module named 'build_real'")
        with mock.patch.object(serve,'load_real',missing),mock.patch.object(serve.importlib.util,'find_spec',lambda name:None):
            with self.assertRaises(serve.ApiError) as e:self.jobs.create({'network':'real'})
            self.assertEqual((e.exception.status,e.exception.code),(500,'sumo_error'))
            self.assertEqual(self.jobs.active,0)
            self.assertEqual(self.jobs.route('GET',serve.PREFIX+'/health')[1]['networks'],['synthetic'])
            self.assertEqual(self.complete()['status'],'complete')

    def test_real_failure_keeps_logs_drops_partial_output(self):
        def broken(args):
            raw=pathlib.Path(args.work_dir);(raw/'ai').mkdir(parents=True)
            (raw/'ai/fcd.xml').write_bytes(b' '*1_500_000);(raw/'ai/sumo.log').write_text('log')
            fake_build_real(args);raise RuntimeError('Simulation integrity failure ai: 3 collisions')
        self.real_jobs(build=broken);job=self.run_real({'network':'real'})
        root=pathlib.Path(self.temp.name)/job['id']
        self.assertEqual(job['status'],'failed');self.assertNotIn('result',job);self.assertIn('3 collisions',job['error'])
        self.assertFalse((root/'output').exists());self.assertFalse((root/'raw/ai/fcd.xml').exists())
        self.assertTrue((root/'raw/ai/sumo.log').exists())
        with self.assertRaises(serve.ApiError) as e:self.jobs.route('GET',f"{serve.PREFIX}/runs/{job['id']}/index.json")
        self.assertEqual(e.exception.status,409)

    def test_output_files_are_sent_byte_for_byte_so_sha256_matches(self):
        # Must stay byte-identical even if the writer used another format (indentation, \\u escapes): the browser checks the received body against the sha256 in the manifest
        def indented(args):
            fake_build_real(args);f=pathlib.Path(args.output)/'ai/frames-000.json'
            f.write_text(json.dumps({'frames':[{'t':0,'a':[],'tls':{'x':'Gr'},'q':1.5,'note':'路口'}]},indent=1))
        self.real_jobs(build=indented);job=self.run_real({'network':'real'})
        raw=self.http(f"GET /sumo/v1/runs/{job['id']}/ai/frames-000.json HTTP/1.0\r\n\r\n".encode())
        body=raw.partition(b'\r\n\r\n')[2]
        self.assertIn(b'200',raw.splitlines()[0])
        self.assertEqual(body,(pathlib.Path(self.temp.name)/job['id']/'output/ai/frames-000.json').read_bytes())
        self.assertIn(b'Content-Length: '+str(len(body)).encode(),raw)
        status,value=self.jobs.route('GET',f"{serve.PREFIX}/runs/{job['id']}/ai/frames-000.json")
        self.assertEqual(value['frames'][0]['note'],'路口')

    @unittest.skipUnless((TOOLS/'build_real.py').exists(),'build_real.py not present')
    def test_build_real_validate_matches_contract_f(self):
        import build_real
        v=build_real.validate_real({})
        self.assertTrue({'seed','p_original','p_ai','scenarios'}<=set(v))
        self.assertEqual(sorted(v['scenarios']),sorted(REAL_IDS))
        for ok in [{'seed':0},{'seed':2147483647},{'p_original':0},{'p_ai':1},{'scenarios':['ai']},{'scenarios':['baseline','original']}]:
            with self.subTest(ok=ok):build_real.validate_real(ok)
        for bad in [{'seed':-1},{'seed':2147483648},{'seed':1.5},{'seed':True},{'p_ai':-.01},{'p_ai':1.01},{'p_original':float('nan')},
                    {'p_ai':'0.5'},{'scenarios':[]},{'scenarios':['closure']},{'scenarios':'ai'},{'weather':'rain'},None,[]]:
            with self.subTest(bad=bad),self.assertRaises(ValueError):build_real.validate_real(bad)

    def test_real_socket_server_answers_head(self):
        with mock.patch.object(serve.Handler,'log_message',lambda *args:None):
            server=serve.make_server(0,self.jobs)
            threading.Thread(target=server.serve_forever,daemon=True).start()
            try:
                request=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/sumo/v1/health',method='HEAD')
                with urllib.request.urlopen(request,timeout=5) as response:self.assertEqual((response.status,response.read()),(200,b''))
                self.assertEqual(server.RequestHandlerClass.timeout,30)
            finally:server.shutdown();server.server_close()

    # ---- Options mode: {network:'real', seed?, options:[{id,p}], frames?} → baseline + opt-<id>; the old {p_original,p_ai,scenarios} form is unchanged ----
    OPTS=[{'id':'C','p':.607},{'id':'A','p':.14},{'id':'B','p':.14}]

    def options_jobs(self):
        import build_real
        return self.real_jobs(build=fake_build_options,validate=build_real.validate_real)

    def test_real_options_job_config_and_build_args(self):
        calls=self.options_jobs()
        job=self.run_real({'network':'real','seed':7,'options':self.OPTS})
        self.assertEqual(job['status'],'complete')
        want=[{'id':'A','p':.14},{'id':'B','p':.14},{'id':'C','p':.607}]  # sorted by id
        self.assertEqual(job['config'],{'network':'real','seed':7,'options':want,'frames':False,'scenarios':['baseline','opt-A','opt-B','opt-C']})
        root=pathlib.Path(self.temp.name).resolve()/job['id']
        self.assertEqual(vars(calls[0]),{'seed':7,'options':want,'frames':False,'scenarios':['baseline','opt-A','opt-B','opt-C'],
                                         'output':root/'output','work_dir':root/'raw'})
        # The old form still works: no options / frames fields
        job2=self.jobs.configure({'network':'real','p_ai':.6})
        self.assertEqual(job2,{'network':'real','seed':42,'p_original':.14,'p_ai':.6,'scenarios':list(REAL_IDS)})

    def test_real_options_serves_only_opt_a_to_e(self):
        self.options_jobs()
        job=self.run_real({'network':'real','options':[{'id':'A','p':.2},{'id':'E','p':1}],'frames':True})
        base=f"{serve.PREFIX}/runs/{job['id']}/"
        status,index=self.jobs.route('GET',job['result'])
        self.assertEqual([s['id'] for s in index['scenarios']],['baseline','opt-A','opt-E'])
        for sid in ['baseline','opt-A','opt-E']:
            with self.subTest(sid=sid):
                status,meta=self.jobs.route('GET',base+sid+'/manifest.json')
                self.assertEqual((status,meta['scenario']),(200,sid))
                status,chunk=self.jobs.route('GET',base+sid+'/frames-000.json')
                self.assertEqual((status,len(chunk['frames'])),(200,2))
        for path in ['opt-B/manifest.json','opt-F/manifest.json','opt-a/manifest.json','opt-AB/manifest.json','opt-/manifest.json','OPT-A/manifest.json',
                     'opt-A/../job.json','opt-A/frames-1.json','opt-A/index.json','option-A/manifest.json','opt-A/manifest.json/']:
            with self.subTest(path=path),self.assertRaises(serve.ApiError) as e:self.jobs.route('GET',base+path)
            self.assertEqual(e.exception.status,404)

    def test_real_options_default_writes_metrics_only(self):
        self.options_jobs()
        job=self.run_real({'network':'real','options':[{'id':'B','p':0}]})
        base=f"{serve.PREFIX}/runs/{job['id']}/"
        status,meta=self.jobs.route('GET',base+'opt-B/manifest.json')
        self.assertEqual((status,meta['chunks']),(200,[]))
        with self.assertRaises(serve.ApiError) as e:self.jobs.route('GET',base+'opt-B/frames-000.json')
        self.assertEqual(e.exception.status,404)

    def test_real_options_validation_errors_are_bad_config(self):
        calls=self.options_jobs()
        for options in [[],[{'id':x,'p':.1} for x in 'ABCDEA'],[{'id':'F','p':.1}],[{'id':'a','p':.1}],[{'id':'A','p':.1},{'id':'A','p':.2}],
                        [{'id':'A','p':1.5}],[{'id':'A','p':-.01}],[{'id':'A','p':float('nan')}],[{'id':'A','p':'0.5'}],[{'id':'A','p':True}],
                        [{'id':'A'}],[{'id':'A','p':.1,'label':'x'}],['A'],'A',{'A':.1},None]:
            with self.subTest(options=options),self.assertRaises(serve.ApiError) as e:self.jobs.create({'network':'real','options':options})
            self.assertEqual((e.exception.status,e.exception.code),(400,'bad_config'))
        ok=[{'id':'A','p':.1}]
        for extra in [{'p_ai':.5},{'p_original':.1},{'scenarios':['baseline']},{'frames':'no'},{'frames':1},{'seed':-1},{'seed':1.5},{'weather':'rain'}]:
            with self.subTest(extra=extra),self.assertRaises(serve.ApiError) as e:self.jobs.create({'network':'real','options':ok,**extra})
            self.assertEqual((e.exception.status,e.exception.code),(400,'bad_config'))
        self.assertEqual((self.jobs.active,calls),(0,[]))
        raw=self.post(b'{"network":"real","options":[{"id":"Z","p":0.1}]}')
        self.assertIn(b'400',raw.splitlines()[0]);self.assertIn(b'"error":"bad_config"',raw)
        raw=self.post(b'{"network":"real","seed":3,"options":[{"id":"A","p":0.14},{"id":"B","p":0.14},{"id":"C","p":0.607}]}')
        self.assertIn(b'202',raw.splitlines()[0])
        body=json.loads(raw.partition(b'\r\n\r\n')[2]);self.assertEqual(body['config']['scenarios'],['baseline','opt-A','opt-B','opt-C'])


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(BackendTests))
    failed=len(result.errors)+len(result.failures)
    print(f'{result.testsRun-failed} passed, {failed} failed')
    sys.exit(1 if failed else 0)
