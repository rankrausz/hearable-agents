// packages/core/test/classify/hash.test.ts — known-answer tests for the pure
// SHA-256 in src/classify/hash.ts. Expected digests were generated with two
// independent real implementations (macOS shasum and node:crypto) and match
// the published FIPS vectors; a regression that makes the digest wrong is
// caught here even though nothing downstream compares full digests.

import { describe, expect, it } from "vitest";

import { sha256Hex, truncatedSha256 } from "../../src/classify/hash.js";

describe("sha256Hex", () => {
  const vectors: Array<[string, string]> = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    // Multi-byte UTF-8 (U+00E7, encoded as 0xC3 0xA7) proving the byte
    // encoder, not just ASCII.
    ["ç", "8bfa829b8119a6f39b91fd8decec63830b556e4d88a9da29334d7b0558829f2d"],
    // 1,000,000 'a' bytes spans many blocks and the length-padding boundary.
    ["a".repeat(1000000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
  ];

  it.each(vectors)("digests %# to the published vector", (input, digest) => {
    expect(sha256Hex(input)).toBe(digest);
  });

  it("differs between inputs that differ in a single byte", () => {
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
    expect(sha256Hex("same")).not.toBe(sha256Hex("same "));
  });
});

describe("truncatedSha256", () => {
  it("keeps exactly 16 lowercase hex characters", () => {
    expect(truncatedSha256("any input")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is the head of the full digest", () => {
    expect(truncatedSha256("any input")).toBe(sha256Hex("any input").slice(0, 16));
  });
});
