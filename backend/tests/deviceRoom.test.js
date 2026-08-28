import test from "node:test";
import assert from "node:assert/strict";
import { deviceCount, isDeviceConnected, DEVICE_ROOM } from "../sockets/deviceRoom.js";

/** Minimal stand-in for the Socket.IO server, shaped like the bit we read. */
const io = (rooms) => ({ sockets: { adapter: { rooms: new Map(rooms) } } });

test("a connected ESP32 is counted", () => {
  assert.equal(deviceCount(io([[DEVICE_ROOM, new Set(["sock-1"])]])), 1);
  assert.equal(isDeviceConnected(io([[DEVICE_ROOM, new Set(["sock-1"])]])), true);
});

test("two boxes on the same room both count", () => {
  assert.equal(deviceCount(io([[DEVICE_ROOM, new Set(["a", "b"])]])), 2);
});

test("no device room at all means nothing is connected", () => {
  assert.equal(deviceCount(io([])), 0);
  assert.equal(isDeviceConnected(io([])), false);
});

test("an EMPTY device room means nothing is connected", () => {
  // Socket.IO deletes a room when its last member leaves, but an empty Set must not
  // read as "connected" if one is ever left behind.
  assert.equal(deviceCount(io([[DEVICE_ROOM, new Set()]])), 0);
  assert.equal(isDeviceConnected(io([[DEVICE_ROOM, new Set()]])), false);
});

test("browser rooms are not mistaken for devices", () => {
  const rooms = io([["user:1", new Set(["b1"])], ["sock-x", new Set(["b1"])]]);
  assert.equal(isDeviceConnected(rooms), false);
});

test("a missing or malformed io fails CLOSED, never throws", () => {
  // The guard must refuse the command rather than let it through unchecked while the
  // server is still starting, or in a test with no socket layer at all.
  for (const bad of [null, undefined, {}, { sockets: null }, { sockets: { adapter: {} } }]) {
    assert.equal(deviceCount(bad), 0);
    assert.equal(isDeviceConnected(bad), false);
  }
});

test("an adapter that throws is treated as disconnected", () => {
  const hostile = {
    sockets: {
      adapter: {
        get rooms() {
          throw new Error("adapter exploded");
        },
      },
    },
  };
  assert.equal(isDeviceConnected(hostile), false);
});
