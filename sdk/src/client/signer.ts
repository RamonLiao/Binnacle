import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import type { Signer } from '@mysten/sui/cryptography';

/**
 * Build a Signer from `SUI_PRIVATE_KEY` (a `suiprivkey1...` bech32 string).
 * Fail-loud on missing / malformed / unsupported-scheme. Never echoes the key value.
 */
export function signerFromEnv(env: NodeJS.ProcessEnv = process.env): Signer {
  const raw = env.SUI_PRIVATE_KEY;
  if (!raw) throw new Error('SUI_PRIVATE_KEY is not set');

  let parsed: ReturnType<typeof decodeSuiPrivateKey>;
  try {
    parsed = decodeSuiPrivateKey(raw);
  } catch {
    throw new Error('SUI_PRIVATE_KEY is not a valid suiprivkey bech32 string');
  }

  switch (parsed.scheme) {
    case 'ED25519':
      return Ed25519Keypair.fromSecretKey(parsed.secretKey);
    case 'Secp256k1':
      return Secp256k1Keypair.fromSecretKey(parsed.secretKey);
    case 'Secp256r1':
      return Secp256r1Keypair.fromSecretKey(parsed.secretKey);
    default:
      throw new Error(`unsupported key scheme: ${parsed.scheme}`);
  }
}
