import { SuiGrpcClient } from '@mysten/sui/grpc';

export const PACKAGE_ID =
  process.env.PACKAGE_ID ??
  '0xcb5cc62066b4bbc2e66961b48d5141f9cf3ec119e33a7f6d6ec235a1d413b14c';

export const GRPC_BASE_URL =
  process.env.GRPC_BASE_URL ?? 'https://fullnode.testnet.sui.io:443';

export function grpcClient(): SuiGrpcClient {
  return new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC_BASE_URL });
}

/** Fail-loud required-env reader. Never echoes the value. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (paste it into sdk/.env)`);
  return v;
}

export function suiscan(digest: string): string {
  return `https://suiscan.xyz/testnet/tx/${digest}`;
}
