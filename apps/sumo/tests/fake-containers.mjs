// Fake @cloudflare/containers for tests (the real package imports 'cloudflare:workers', which Node cannot load)
// tests/worker.test.mjs points '@cloudflare/containers' here through a node:module hook; this is not a test file itself (not named *.test.mjs)
export const calls = [];

export class Container {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

// Records the arguments worker.js uses to get the container; binding.stub is the fake container the test injects
export function getContainer(binding, name) {
  calls.push({ binding, name });
  if (!binding) throw new TypeError("Cannot read properties of undefined (reading 'idFromName')");
  return binding.stub;
}
