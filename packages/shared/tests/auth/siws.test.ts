import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildSiwsMessage, verifySiwsSignature } from "../../src/auth/siws.js";

const ISSUED_AT = new Date("2026-04-27T15:00:00Z");
const EXPIRES_AT = new Date("2026-04-27T15:05:00Z");

function makeKeypair(): { wallet: string; secretKey: Uint8Array; publicKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  return {
    wallet: bs58.encode(kp.publicKey),
    secretKey: kp.secretKey,
    publicKey: kp.publicKey,
  };
}

describe("buildSiwsMessage", () => {
  it("includes wallet, nonce, issuedAt, expirationTime in canonical format", () => {
    const message = buildSiwsMessage({
      wallet: "ABC123",
      nonce: "nonce-xyz",
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      domain: "onchainme.xyz",
    });

    expect(message).toContain("OnchainMe wants you to sign in");
    expect(message).toContain("ABC123");
    expect(message).toContain("Nonce: nonce-xyz");
    expect(message).toContain("Issued At: 2026-04-27T15:00:00.000Z");
    expect(message).toContain("Expiration Time: 2026-04-27T15:05:00.000Z");
    expect(message).toContain("URI: https://onchainme.xyz");
    expect(message).toContain("Chain ID: solana:mainnet");
  });
});

describe("verifySiwsSignature", () => {
  it("returns true for a valid signature over the canonical message", () => {
    const kp = makeKeypair();
    const message = buildSiwsMessage({
      wallet: kp.wallet,
      nonce: "n1",
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      domain: "onchainme.xyz",
    });
    const signature = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);

    const ok = verifySiwsSignature({
      wallet: kp.wallet,
      message,
      signatureBase58: bs58.encode(signature),
    });
    expect(ok).toBe(true);
  });

  it("returns false for a signature from the wrong wallet", () => {
    const kpRight = makeKeypair();
    const kpWrong = makeKeypair();
    const message = buildSiwsMessage({
      wallet: kpRight.wallet,
      nonce: "n1",
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      domain: "onchainme.xyz",
    });
    const signature = nacl.sign.detached(new TextEncoder().encode(message), kpWrong.secretKey);

    const ok = verifySiwsSignature({
      wallet: kpRight.wallet,
      message,
      signatureBase58: bs58.encode(signature),
    });
    expect(ok).toBe(false);
  });

  it("returns false when signature bytes are malformed", () => {
    const kp = makeKeypair();
    const message = buildSiwsMessage({
      wallet: kp.wallet,
      nonce: "n1",
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      domain: "onchainme.xyz",
    });

    const ok = verifySiwsSignature({
      wallet: kp.wallet,
      message,
      signatureBase58: "not-a-real-signature",
    });
    expect(ok).toBe(false);
  });

  it("returns false when wallet address is not a valid base58 pubkey", () => {
    const ok = verifySiwsSignature({
      wallet: "not-base58-!!!",
      message: "anything",
      signatureBase58: bs58.encode(new Uint8Array(64)),
    });
    expect(ok).toBe(false);
  });
});
