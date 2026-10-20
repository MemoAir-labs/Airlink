import { describe, expect, it } from "vitest";

import { createInputMux } from "./index.ts";

const hana = { kind: "human" as const, id: "u1", name: "Hana" };
const tom = { kind: "human" as const, id: "u2", name: "Tom" };
const juno = { kind: "agent" as const, id: "a1", name: "Juno" };

describe("input mux", () => {
  it("lets a person take the controls from an agent at once", () => {
    const mux = createInputMux();
    expect(mux.claim(juno, 1000)).toEqual({ ok: true });
    expect(mux.claim(hana, 1001)).toEqual({ ok: true });
    expect(mux.holder(1002)).toEqual(hana);
  });

  it("makes an agent wait until the person has paused", () => {
    const mux = createInputMux({ humanIdleMs: 3000 });
    mux.claim(hana, 1000);
    expect(mux.claim(juno, 2000)).toEqual({ ok: false, heldBy: hana });
    expect(mux.claim(juno, 4000)).toEqual({ ok: true });
    expect(mux.holder(4000)).toEqual(juno);
  });

  it("keeps the controls with the active person when another person grabs", () => {
    const mux = createInputMux({ humanIdleMs: 3000 });
    mux.claim(hana, 1000);
    expect(mux.claim(tom, 1500)).toEqual({ ok: false, heldBy: hana });
    expect(mux.claim(tom, 4500)).toEqual({ ok: true });
  });

  it("renews on every input by the holder and lapses when quiet", () => {
    const mux = createInputMux({ humanIdleMs: 3000, lapseMs: 10_000 });
    mux.claim(hana, 1000);
    mux.claim(hana, 8000);
    expect(mux.holder(17_000)).toEqual(hana);
    expect(mux.holder(18_000)).toBeNull();
    expect(mux.claim(juno, 18_000)).toEqual({ ok: true });
  });

  it("releases only the holder's own claim", () => {
    const mux = createInputMux();
    mux.claim(juno, 1000);
    mux.release("someone-else");
    expect(mux.holder(1000)).toEqual(juno);
    mux.release(juno.id);
    expect(mux.holder(1000)).toBeNull();
  });
});
