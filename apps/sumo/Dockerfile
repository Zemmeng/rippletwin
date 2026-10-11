# Container image for hackathon-sumo: native SUMO 1.27.1 + apps/web/tools/sumo/serve.py (HTTP API /sumo/v1/*)
# Two networks: synthetic 2×2 (build_demo.py, unchanged) + the real CBD network (build_real.py, contract v2, reads network / signals / flows from apps/roads)
# Build context = apps/ (image_build_context ".." in wrangler.jsonc), so every COPY path below is relative to apps/;
#   the image mirrors the repo layout (/app/web/tools/sumo, /app/roads/public/cbd), so scripts that locate data via __file__ still work
# Local test build (no push): docker build --platform linux/amd64 -f apps/sumo/Dockerfile apps
#   Cloudflare runs linux/amd64 only; wrangler deploy adds --platform linux/amd64 itself, and Apple silicon relies on colima's Rosetta translation
#   BuildKit sends only the files COPY uses, so apps/*/node_modules never enters the context
FROM python:3.12-slim

# The eclipse-sumo manylinux wheel bundles FOX / xerces / proj etc. but not the X11 / GL client libraries or libatomic (they are on the
# manylinux allow-list), and the slim image lacks them too; sumo will not start if any is missing. The ldd check below fails the build
# instead of letting this surface in production (that is how libatomic1 was found)
RUN apt-get update \
 && apt-get install -y --no-install-recommends libx11-6 libxext6 libxrender1 libgl1 libsm6 libice6 libatomic1 \
 && rm -rf /var/lib/apt/lists/*

# Runtime variables: serve.py listens on HOST / PORT, writes results to SUMO_DATA_DIR and keeps only the newest SUMO_KEEP_RUNS runs
# SumoContainer.envVars in worker.js passes the same values again on every start (change both together)
# ALLOW_ORIGINS deliberately unset: the Worker already strips the browser's Origin header, and the container only receives requests forwarded by the Worker
# LANG=C.UTF-8: build_demo.py reads the first line of `sumo --version`, which a wrong locale garbles
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    HOST=0.0.0.0 PORT=8080 SUMO_DATA_DIR=/data SUMO_KEEP_RUNS=20 SUMO_REAL_JOBS=4

WORKDIR /app
COPY web/tools/sumo/requirements.txt web/tools/sumo/requirements.txt
# numpy + scipy: real-network demand is sampled from SCATS counts with SUMO's bundled tools/routeSampler.py, which imports numpy at top level and needs scipy for --optimize
RUN pip install -r web/tools/sumo/requirements.txt numpy==2.2.6 scipy==1.15.3

# Check at build time: a missing shared library, a wrong version or missing routeSampler dependencies fail the build (rather than surfacing after deploying to Cloudflare)
RUN SUMO_HOME=$(python -c 'import sumo; print(sumo.SUMO_HOME)') \
 && ! ldd "$SUMO_HOME/bin/sumo" "$SUMO_HOME/bin/netconvert" | grep 'not found' \
 && sumo --version | grep -q 'Eclipse SUMO sumo 1.27.1' \
 && netconvert --version > /dev/null \
 && test -f "$SUMO_HOME/tools/routeSampler.py" \
 && python -c 'import numpy, scipy.optimize'

# Real-network inputs: OSM network + SCATS junctions + SCATS 08:00–09:00 flows (only these three; no other roads data enters the image)
COPY roads/public/cbd/network.json roads/public/cbd/signals.json roads/public/cbd/flows.json roads/public/cbd/
# SUMO_REAL_CACHE: build_real.py's network + routeSampler demand cache (keyed on build_real.py + the three JSON files + SUMO version), built below at build time
ENV SUMO_ROADS_DIR=/app/roads/public/cbd SUMO_REAL_CACHE=/app/real-cache

# Keep the web/tools/sumo directory level: build_demo.py uses Path(__file__).parents[2] as the working directory for `sumo --version`
COPY web/tools/sumo/build_demo.py web/tools/sumo/build_real.py web/tools/sumo/serve.py web/tools/sumo/smoke.py web/tools/sumo/

# Run one minimal end-to-end check at build time (real netconvert + sumo + replay export, about 1 s on an Apple M5), deleted once it passes
# Parameters must be within the public ranges: clearance_s 600–2400 (< 600 fails with short demand, tested)
RUN python web/tools/sumo/build_demo.py --scenarios closure --demand-duration-s 60 --clearance-s 600 \
      --output /tmp/check-out --work-dir /tmp/check-raw > /dev/null \
 && test -f /tmp/check-out/index.json \
 && rm -rf /tmp/check-out /tmp/check-raw

# Real network: build the cache at build time (real netconvert for both networks + randomTrips + routeSampler --optimize), so each live run only runs sumo;
# this also checks that build_real imports and its parameter validation works: missing numpy / scipy / roads data fails the build
RUN cd web/tools/sumo && python -c "import build_real; build_real.validate_real({'seed': 1, 'scenarios': ['baseline']})" \
 && python build_real.py --prepare-only \
 && test -f "$(python build_real.py --prepare-only)/demand.json"

# Runs as root: /data is the container's own ephemeral disk (wiped on sleep / restart), no volume is mounted, so there are no permission issues
RUN mkdir -p /data
EXPOSE 8080

# Cloudflare ignores HEALTHCHECK (it probes the port via SumoContainer.pingEndpoint); kept for local docker run
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/sumo/v1/health' % os.environ.get('PORT','8080'), timeout=4)"

# serve.py handles SIGTERM itself (sent by Cloudflare on sleep / restart): the running job finishes, queued jobs are dropped
CMD ["python", "web/tools/sumo/serve.py"]
