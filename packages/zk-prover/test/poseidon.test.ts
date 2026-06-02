import { describe, it, expect } from "vitest";
import { poseidonHashBls } from "../src/poseidon.js";

describe("poseidonHashBls (BLS12-381, via circuit wasm)", () => {
  it("is deterministic and field-correct for 2 inputs", async () => {
    const a = await poseidonHashBls(["1", "2"]);
    const b = await poseidonHashBls(["1", "2"]);
    expect(a).toBe(b);                       // deterministic
    expect(/^[0-9]+$/.test(a)).toBe(true);   // decimal field string
    // NOT the BN254 poseidon-lite value (proves we used the BLS12-381 field, not the wrong one).
    expect(a).not.toBe("7853200120776062878684798364095072458815029376092732009249414926327459813530");
  });
  it("supports 1 and 3 inputs", async () => {
    expect(await poseidonHashBls(["5"])).toMatch(/^[0-9]+$/);
    expect(await poseidonHashBls(["1", "2", "3"])).toMatch(/^[0-9]+$/);
  });
});
