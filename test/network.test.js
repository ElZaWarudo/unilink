import assert from "node:assert/strict";
import test from "node:test";

import {
  isLocalNetworkAddress,
  listLanAddresses,
  selectLanAddress,
} from "../src/network.js";

const interfaces = {
  virtual: [
    { family: "IPv4", internal: false, address: "192.168.56.1" },
    { family: "IPv4", internal: false, address: "169.254.10.20" },
  ],
  wifi: [{ family: "IPv4", internal: false, address: "192.168.1.133" }],
  loopback: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
};

test("prioriza la dirección LAN habitual y descarta link-local", () => {
  assert.deepEqual(listLanAddresses(interfaces), [
    "192.168.1.133",
    "192.168.56.1",
  ]);
  assert.equal(selectLanAddress(undefined, interfaces), "192.168.1.133");
});

test("permite fijar manualmente el host publicado", () => {
  assert.equal(
    selectLanAddress("10.0.0.25", interfaces),
    "10.0.0.25",
  );
});

test("distingue clientes locales de direcciones públicas", () => {
  for (const address of [
    "127.0.0.1",
    "::1",
    "::ffff:192.168.1.20",
    "10.0.0.5",
    "172.20.4.2",
    "fd12::4",
  ]) {
    assert.equal(isLocalNetworkAddress(address), true, address);
  }
  assert.equal(isLocalNetworkAddress("8.8.8.8"), false);
  assert.equal(isLocalNetworkAddress("172.32.0.1"), false);
});
