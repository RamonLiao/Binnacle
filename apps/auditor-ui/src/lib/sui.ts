import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { SuiGrpcClient } from '@mysten/sui/grpc';

// JSON-RPC client — used ONLY by dapp-kit's SuiClientProvider for wallet connect.
// dapp-kit v1.0.6 `networks` does not accept a gRPC client, so this stays JSON-RPC.
export const suiClient = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl('testnet'),
  network: 'testnet',
});

// gRPC client — used to EXECUTE transactions off the deprecated JSON-RPC transport
// (Quorum Driver disabled / JSON-RPC removal April 2026). Wired into the attest flow
// via useSignAndExecuteTransaction({ execute }).
export const grpcClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});
