import assert from "node:assert/strict";
import test from "node:test";

import { createSubtitleDelayPersistence } from "../src/subtitle-sync.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

test("consolida cambios durante un guardado y persiste el último", async () => {
  let delay = 0.05;
  const requests = [];
  const first = deferred();
  const persistence = createSubtitleDelayPersistence({
    readDelay: () => delay,
    requestSave(value) {
      requests.push(value);
      return requests.length === 1
        ? first.promise
        : Promise.resolve({ subtitleDelay: value });
    },
    debounceMs: 0,
  });

  persistence.schedule();
  const firstSave = persistence.persist();
  delay = 0.1;
  persistence.schedule();
  first.resolve({ subtitleDelay: 0.05 });
  await firstSave;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests, [0.05, 0.1]);
  assert.equal(persistence.isPending(), false);
});

test("mantiene el cambio pendiente tras un error y reintenta", async () => {
  let attempts = 0;
  const states = [];
  const persistence = createSubtitleDelayPersistence({
    readDelay: () => 0.05,
    requestSave() {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ subtitleDelay: 0.05 });
    },
    onStateChange: (state) => states.push(state),
    debounceMs: 0,
  });

  persistence.schedule();
  await persistence.persist();
  assert.equal(persistence.isPending(), true);
  assert.equal(states.at(-1), "error");
  await persistence.retry();
  assert.equal(persistence.isPending(), false);
  assert.equal(states.at(-1), "saved");
  assert.equal(attempts, 2);
});

test("envía el cambio pendiente con keepalive al abandonar la página", () => {
  let options;
  const persistence = createSubtitleDelayPersistence({
    readDelay: () => -0.05,
    requestSave(_value, requestOptions) {
      options = requestOptions;
      return Promise.resolve({ subtitleDelay: -0.05 });
    },
    debounceMs: 60_000,
  });
  persistence.schedule();
  persistence.flushOnExit();
  assert.deepEqual(options, { keepalive: true });
  assert.equal(persistence.isPending(), false);
});
