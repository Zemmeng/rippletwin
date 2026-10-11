// Zero-dependency mini assertions: ok / eq / throws / sec / done
// Passing assertions print nothing; only failures and section titles are printed. done() prints the final "N passed, M failed" line that test.sh parses
// Usage: import { ok, eq, sec, done } from "./mini.mjs"; await sec("section", async () => { ok(x, "what") }); done();

let pass = 0;
let fail = 0;

export function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}

// Compares as JSON, so objects / arrays work directly; prints both sides on failure
export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${msg}\n      actual:   ${a}\n      expected: ${b}`);
}

// fn must throw; if a pattern is given, the error message is checked too
export function throws(fn, pattern, msg) {
  try {
    fn();
  } catch (e) {
    if (pattern && !pattern.test(String(e?.message ?? e))) {
      return ok(false, `${msg} (threw, but with the wrong message: ${e?.message ?? e})`);
    }
    return ok(true, msg);
  }
  ok(false, `${msg} (did not throw)`);
}

// Section: prints the title; runs fn if given, counting an exception thrown inside as 1 failure instead of crashing the whole file
export async function sec(name, fn) {
  console.log(`— ${name}`);
  if (!fn) return;
  try {
    await fn();
  } catch (e) {
    fail++;
    console.log(`  ✗ section threw: ${e?.stack ?? e}`);
  }
}

// On macOS, stdout writes to a pipe asynchronously: wait until the last line is really written before exiting, or `| tail -1` may miss the count line
export function done() {
  process.stdout.write(`${pass} passed, ${fail} failed\n`, () => process.exit(fail ? 1 : 0));
}
