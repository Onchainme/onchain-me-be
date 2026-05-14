import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { loadEnv } from "@onchainme/shared";

/**
 * Solana JSON-RPC proxy.
 *
 * Why we need this:
 *   - The browser-side wallet adapter (Connection) needs to send signed mint
 *     transactions and poll for confirmations against the same cluster the
 *     backend built the tx on (mainnet-beta).
 *   - `api.mainnet-beta.solana.com` returns 403 on browser origins.
 *   - Embedding our Helius API key as NEXT_PUBLIC_SOLANA_RPC_URL bakes the key
 *     into the JS bundle, where anyone can copy it and drain our credits.
 *
 * The proxy keeps the API key server-side. The frontend points `Connection`
 * at this endpoint; web3.js just POSTs JSON-RPC payloads and we forward them
 * to Helius verbatim.
 *
 * Allowed methods: a tight allowlist of read + send operations the mint flow
 * actually needs. Anything else returns 405. This stops the proxy from being
 * a free general-purpose Solana RPC for the world.
 */

// Read + send methods the mint flow + wallet adapters actually call.
// `confirmTransaction` polls getSignatureStatuses AND getBlockHeight in a
// race; missing either left mint stuck on "confirming" until the lastValid
// blockhash expired client-side and we surfaced a misleading error.
const ALLOWED_METHODS = new Set([
  // blockhash / block status
  "getLatestBlockhash",
  "getRecentBlockhash",
  "isBlockhashValid",
  "getBlockHeight",
  "getSlot",
  "getEpochInfo",
  // node health / version (wallet adapters probe these on connect)
  "getHealth",
  "getVersion",
  // account / balance lookups
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getMinimumBalanceForRentExemption",
  "getTokenAccountsByOwner",
  "getTokenAccountBalance",
  // signature / tx lookup (post-send confirmation, history poll)
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTransaction",
  // tx submission + simulation
  "sendTransaction",
  "simulateTransaction",
]);

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown[];
}

function isJsonRpcRequest(body: unknown): body is JsonRpcRequest {
  if (!body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  return (
    obj["jsonrpc"] === "2.0" &&
    typeof obj["method"] === "string" &&
    (typeof obj["id"] === "number" || typeof obj["id"] === "string")
  );
}

export const solanaRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/solana/rpc",
    {
      // Anonymous: the wallet adapter calls this before any session exists.
      // Rate limit per-IP to avoid being a free RPC for the internet.
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          keyGenerator: (req: FastifyRequest) => `solana-rpc:${req.ip}`,
        },
      },
    },
    async (req, reply) => {
      const env = loadEnv();

      // Accept either single request or batch.
      const bodies = Array.isArray(req.body) ? req.body : [req.body];
      for (const b of bodies) {
        if (!isJsonRpcRequest(b)) {
          return reply.code(400).send({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid JSON-RPC request" },
          });
        }
        if (!ALLOWED_METHODS.has(b.method)) {
          return reply.code(405).send({
            jsonrpc: "2.0",
            id: b.id,
            error: {
              code: -32601,
              message: `Method '${b.method}' not allowed via proxy`,
            },
          });
        }
      }

      // Forward verbatim to Helius (or whatever SOLANA_RPC_URL points at).
      const res = await fetch(env.SOLANA_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });

      // Pass through status + body. web3.js inspects the body, so don't
      // unwrap or transform.
      reply.code(res.status);
      const text = await res.text();
      // Try to forward as JSON if it parses; otherwise raw text.
      try {
        return JSON.parse(text);
      } catch {
        return reply.type("text/plain").send(text);
      }
    },
  );
};
