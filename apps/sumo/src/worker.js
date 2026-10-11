// hackathon-sumo (D-0930-1700): live SUMO = this Worker + one Cloudflare Container (apps/sumo/Dockerfile, running apps/web/tools/sumo/serve.py).
// Only the site Worker reaches it, forwarding /api/sumo/v1/* over the SUMO service binding (workers_dev is off, so there is no public URL of its own).
// Whitelist, header stripping, rate limit, busy gate and error codes all live in proxy.js.
// One container instance only (getContainer(…, 'main')): serve.py keeps job state in memory and on ephemeral disk, so a second instance could not see runs created by the first.
// ⚠️ No exports other than default and SumoContainer: workerd treats every named export as an entrypoint (a Durable Object class must be a named export, so that one is fine).
import { Container, getContainer } from '@cloudflare/containers';
import { handle, CONTAINER_ENV } from './proxy.js';

export class SumoContainer extends Container {
  defaultPort = 8080; // = CONTAINER_ENV.PORT = PORT in the Dockerfile
  sleepAfter = '12h'; // stay awake through judging: sleeping wipes the ephemeral disk and the next cold start takes a few seconds; billed while awake (README, cost)
  envVars = { ...CONTAINER_ENV };
  pingEndpoint = 'container/sumo/v1/health'; // probed at start-up (any HTTP response counts as the port being ready); not /, which serve.py does not serve

  onStart() {
    console.log('SUMO container started');
  }

  onStop({ exitCode, reason } = {}) {
    console.log('SUMO container stopped', exitCode, reason);
  }
}

export default {
  async fetch(request, env) {
    return handle(request, env, () => getContainer(env.SUMO_CONTAINER, 'main'));
  },
};
