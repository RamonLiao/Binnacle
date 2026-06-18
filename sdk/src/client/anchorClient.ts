import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import { buildAnchorTx } from '../tx/anchor.ts';
import type { AnchorBatchInput } from '../core/types.ts';

export interface AnchorOpts {
  /** Allow anchoring while Walrus blobIds are still mocked. Default: ALLOW_MOCK_ANCHOR env. */
  allowMockAnchor?: boolean;
}

export class AnchorClient {
  constructor(
    private readonly client: ClientWithCoreApi,
    private readonly signer: Signer,
  ) {}

  async anchorBatch(input: AnchorBatchInput, opts?: AnchorOpts): Promise<{ digest: string }> {
    const allow = opts?.allowMockAnchor ?? (process.env.ALLOW_MOCK_ANCHOR === 'true');
    if (!allow) {
      throw new Error('mock anchor blocked: pass allowMockAnchor or set ALLOW_MOCK_ANCHOR=true');
    }

    const tx = buildAnchorTx(input);
    tx.setSender(this.signer.toSuiAddress());

    const result = await this.signer.signAndExecuteTransaction({
      transaction: tx,
      client: this.client,
    });

    if (result.$kind === 'FailedTransaction') {
      throw new Error(`anchor tx failed before execution: ${JSON.stringify(result.FailedTransaction)}`);
    }
    const status = result.Transaction.effects.status;
    if (!status.success) {
      throw new Error(`anchor tx aborted on-chain: ${JSON.stringify(status.error)}`);
    }
    return { digest: result.Transaction.digest };
  }
}
