import nacl from "tweetnacl";
import bs58 from "bs58";

export interface SiwsMessageInput {
  wallet: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  domain: string;
}

export function buildSiwsMessage(input: SiwsMessageInput): string {
  return [
    `OnchainMe wants you to sign in with your Solana account:`,
    input.wallet,
    ``,
    `Welcome to OnchainMe.`,
    ``,
    `URI: https://${input.domain}`,
    `Version: 1`,
    `Chain ID: solana:mainnet`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expiration Time: ${input.expiresAt.toISOString()}`,
  ].join("\n");
}

export interface VerifySiwsInput {
  wallet: string;
  message: string;
  signatureBase58: string;
}

export function verifySiwsSignature(input: VerifySiwsInput): boolean {
  let pubkeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubkeyBytes = bs58.decode(input.wallet);
    sigBytes = bs58.decode(input.signatureBase58);
  } catch {
    return false;
  }
  if (pubkeyBytes.length !== 32) return false;
  if (sigBytes.length !== 64) return false;

  const messageBytes = new TextEncoder().encode(input.message);
  return nacl.sign.detached.verify(messageBytes, sigBytes, pubkeyBytes);
}
