import { models, type NormalizedTx, type HeliusEnhancedTx } from "@onchainme/shared";

export async function persistRawAndNormalized(
  walletAddress: string,
  rawBatch: HeliusEnhancedTx[],
  normalizedBatch: NormalizedTx[],
): Promise<{ rawInserted: number; normalizedInserted: number }> {
  let rawInserted = 0;
  let normalizedInserted = 0;

  if (rawBatch.length > 0) {
    try {
      const res = await models.TxRawCache.collection.insertMany(
        rawBatch.map((r) => ({
          _id: r.signature,
          walletAddress,
          raw: r,
          fetchedAt: new Date(),
        })) as unknown as Parameters<typeof models.TxRawCache.collection.insertMany>[0],
        { ordered: false },
      );
      rawInserted = res.insertedCount;
    } catch (err: unknown) {
      const e = err as { result?: { insertedCount?: number } };
      rawInserted = e.result?.insertedCount ?? 0;
    }
  }

  if (normalizedBatch.length > 0) {
    try {
      const res = await models.Tx.collection.insertMany(
        normalizedBatch.map((n) => ({
          _id: n.signature,
          walletAddress: n.walletAddress,
          blockTime: n.blockTime,
          protocol: n.protocol,
          action: n.action,
          amountUsd: n.amountUsd,
          meta: n.meta,
        })) as unknown as Parameters<typeof models.Tx.collection.insertMany>[0],
        { ordered: false },
      );
      normalizedInserted = res.insertedCount;
    } catch (err: unknown) {
      const e = err as { result?: { insertedCount?: number } };
      normalizedInserted = e.result?.insertedCount ?? 0;
    }
  }

  return { rawInserted, normalizedInserted };
}
