import * as Y from "yjs";

// Hocuspocus frames are varString(documentName) · varUint(messageType) · payload; sync payloads
// follow y-protocols: varUint(step) · varUint8Array(bytes). Hand-rolled here so a load client
// speaks the same wire as @hocuspocus/provider 4.7 without carrying the provider.
const messageType = { sync: 0, auth: 2 } as const;
const syncStep = { one: 0, update: 2 } as const;
const authType = { token: 0, denied: 1, authenticated: 2 } as const;
const providerVersion = "4.7.0";
const utf8 = new TextEncoder();

function varUint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest > 127) {
    out.push(128 | (rest & 127));
    rest = Math.floor(rest / 128);
  }
  return [...out, rest];
}

const varBytes = (bytes: Uint8Array) => [...varUint(bytes.length), ...bytes];
const varString = (text: string) => varBytes(utf8.encode(text));
const frame = (docName: string, ...parts: number[][]) =>
  Uint8Array.from([...varString(docName), ...parts.flat()]);

export function authMessage(docName: string, token: string): Uint8Array {
  return frame(
    docName,
    varUint(messageType.auth),
    varUint(authType.token),
    varString(token),
    varString(providerVersion)
  );
}

export function syncStepOneMessage(docName: string): Uint8Array {
  return frame(
    docName,
    varUint(messageType.sync),
    varUint(syncStep.one),
    varBytes(Y.encodeStateVector(new Y.Doc()))
  );
}

export function updateMessage(docName: string, update: Uint8Array): Uint8Array {
  return frame(
    docName,
    varUint(messageType.sync),
    varUint(syncStep.update),
    varBytes(update)
  );
}

function readVarUint(bytes: Uint8Array, start: number): [number, number] {
  let value = 0;
  let factor = 1;
  let pos = start;
  while (pos < bytes.length) {
    const byte = bytes[pos];
    pos += 1;
    value += (byte & 127) * factor;
    if (byte < 128) {
      break;
    }
    factor *= 128;
  }
  return [value, pos];
}

function readVarString(bytes: Uint8Array, start: number): string {
  const [length, pos] = readVarUint(bytes, start);
  return new TextDecoder().decode(bytes.subarray(pos, pos + length));
}

export type Stamp = { client: number; sentAtMs: number };
export type Frame =
  | { type: "update"; stamps: Stamp[] }
  | { type: "authenticated" }
  | { type: "denied"; reason: string }
  | { type: "other" };

// The sender puts its send time in the map key. Yjs writes a key as plain UTF-8 inside the
// update only when the key is new (an overwrite carries the previous item's id instead), so the
// sequence keeps every key unique and a receiver reads every stamp off the raw frame without
// applying it.
const stampKey = /c(\d+):\d+:(\d{13})/g;
export const stampKeyFor = (client: number, seq: number, sentAtMs: number) =>
  `c${client}:${seq}:${sentAtMs}`;

export function parseFrame(bytes: Uint8Array): Frame {
  const [nameLength, afterLength] = readVarUint(bytes, 0);
  const [type, afterType] = readVarUint(bytes, afterLength + nameLength);
  if (type === messageType.auth) {
    const [auth, afterAuth] = readVarUint(bytes, afterType);
    if (auth === authType.authenticated) {
      return { type: "authenticated" };
    }
    if (auth === authType.denied) {
      return { type: "denied", reason: readVarString(bytes, afterAuth) };
    }
    return { type: "other" };
  }
  if (type !== messageType.sync) {
    return { type: "other" };
  }
  const [step] = readVarUint(bytes, afterType);
  if (step !== syncStep.update) {
    return { type: "other" };
  }
  const text = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).toString("latin1");
  return {
    type: "update",
    stamps: [...text.matchAll(stampKey)].map((match) => ({
      client: Number(match[1]),
      sentAtMs: Number(match[2]),
    })),
  };
}
