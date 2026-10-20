import {
  collectDefaultMetrics,
  Gauge,
  Histogram,
  Registry,
} from "@prometheus-io/client";

const bucketsMs = [5, 10, 25, 50, 100, 150, 250, 500, 1000];
// Agent ops stream on purpose (30 ms a rich-text frame, 180 ms a slide), so a deck takes seconds.
const opBucketsMs = [...bucketsMs, 2500, 5000, 10000];

export function createMetrics({
  connections,
  rooms,
}: {
  connections: () => number;
  rooms: () => number;
}) {
  const registry = new Registry();
  // Event-loop lag, GC and CPU: the bench reads the lag percentiles to tell a slow server from a
  // slow load generator, since they reset on every scrape.
  collectDefaultMetrics({ register: registry });
  const histogram = (name: string, help: string, buckets = bucketsMs) =>
    new Histogram({ name, help, buckets, registers: [registry] });
  new Gauge({
    name: "live_connections",
    help: "Open WebSocket connections.",
    registers: [registry],
    collect() {
      this.set(connections());
    },
  });
  new Gauge({
    name: "live_rooms",
    help: "Docs loaded in memory.",
    registers: [registry],
    collect() {
      this.set(rooms());
    },
  });
  return {
    registry,
    fanoutMs: histogram(
      "live_fanout_ms",
      "A client's Yjs update from receipt to its broadcast being queued, in ms; sync steps, awareness and stateless input are not counted."
    ),
    agentOpMs: histogram(
      "live_agent_op_ms",
      "A successful agent ops request from parse to ack, doc load and streaming included, in ms.",
      opBucketsMs
    ),
    loadMs: histogram(
      "live_load_ms",
      "Loading a doc's state from the update log, in ms."
    ),
    frameIntervalMs: histogram(
      "live_frame_interval_ms",
      "Gap between consecutive shared-browser frames, in ms."
    ),
    inputToFrameMs: histogram(
      "live_input_to_frame_ms",
      "A shared-browser input from receipt to the next screencast frame, in ms; the Chromium leg of input → pixels."
    ),
    decideMs: new Histogram({
      name: "live_decide_ms",
      help: "A decision-node round trip, in ms, by provider; no opinion counts too.",
      buckets: bucketsMs,
      labelNames: ["provider"],
      registers: [registry],
    }),
  };
}

export type LiveMetrics = ReturnType<typeof createMetrics>;

// A Hocuspocus frame is varString(docName) · varUint(messageType) · payload; a Sync (0) frame
// then carries varUint(step), where 2 is a Yjs update (0 and 1 are the handshake).
export function isSyncUpdate(frame: Uint8Array): boolean {
  let offset = 0;
  const varUint = () => {
    let value = 0;
    let shift = 0;
    while (offset < frame.length) {
      const byte = frame[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (byte < 0x80) {
        return value;
      }
    }
    return -1;
  };
  const nameLength = varUint();
  offset += nameLength;
  return varUint() === 0 && varUint() === 2;
}
