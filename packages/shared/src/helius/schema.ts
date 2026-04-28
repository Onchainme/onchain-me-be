import { z } from "zod";

export const heliusEventSwapSchema = z.object({
  innerSwaps: z.array(z.unknown()).optional(),
  nativeInput: z
    .object({ account: z.string(), amount: z.string() })
    .nullable()
    .optional(),
  nativeOutput: z
    .object({ account: z.string(), amount: z.string() })
    .nullable()
    .optional(),
  tokenInputs: z.array(z.unknown()).optional(),
  tokenOutputs: z.array(z.unknown()).optional(),
  tokenFees: z.array(z.unknown()).optional(),
  nativeFees: z.array(z.unknown()).optional(),
});

export const heliusEventNftSchema = z.object({
  description: z.string().optional(),
  type: z.string().optional(),
  source: z.string().optional(),
  amount: z.number().optional(),
  fee: z.number().optional(),
  feePayer: z.string().optional(),
  signature: z.string().optional(),
  slot: z.number().optional(),
  timestamp: z.number().optional(),
  saleType: z.string().optional(),
  buyer: z.string().optional(),
  seller: z.string().optional(),
  staker: z.string().optional(),
  nfts: z
    .array(z.object({ mint: z.string(), tokenStandard: z.string().nullable().optional() }))
    .optional(),
});

export const heliusEnhancedTxSchema = z.object({
  signature: z.string(),
  slot: z.number(),
  timestamp: z.number(),
  fee: z.number().optional(),
  feePayer: z.string().optional(),
  type: z.string(),
  source: z.string(),
  description: z.string().optional(),
  events: z
    .object({
      swap: heliusEventSwapSchema.optional(),
      nft: heliusEventNftSchema.optional(),
    })
    .partial()
    .optional(),
  tokenTransfers: z.array(z.unknown()).optional(),
  nativeTransfers: z.array(z.unknown()).optional(),
  accountData: z.array(z.unknown()).optional(),
  transactionError: z.unknown().nullable().optional(),
});

export type HeliusEnhancedTx = z.infer<typeof heliusEnhancedTxSchema>;
export const heliusEnhancedTxArraySchema = z.array(heliusEnhancedTxSchema);
