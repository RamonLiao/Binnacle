/// Centralized error codes for the compliance_vault package.
///
/// NOTE: Move constants are module-private, so they cannot be referenced from
/// other modules. We expose codes as `public fun` accessors instead. `assert!`
/// only evaluates the code expression on the abort path, so these calls cost
/// nothing on the happy path. The numeric values match spec §8 (ABI-stable).
module compliance_vault::errors;

const E_SEQ_GAP: u64 = 1;
const E_SEQ_REPLAY: u64 = 2;
const E_LEN_MISMATCH: u64 = 3;
const E_POLICY_IMMUTABLE: u64 = 4;
const E_NAMESPACE_SEALED: u64 = 5;
const E_ENGAGEMENT_EXPIRED: u64 = 6;
const E_ENGAGEMENT_REVOKED: u64 = 7;
const E_SCOPE_MISMATCH: u64 = 8;
const E_UNAUTHORIZED_WRITER: u64 = 9;
const E_INVALID_MERKLE_PROOF: u64 = 10;
const E_PARENT_HASH_MISMATCH: u64 = 11;
const E_UNAUTHORIZED: u64 = 12;
const E_SEQ_OVERFLOW: u64 = 13;

/// seq_start is ahead of the expected next sequence (a gap was introduced).
public fun seq_gap(): u64 { E_SEQ_GAP }
/// seq_start is behind the expected next sequence (replay / rewrite attempt).
public fun seq_replay(): u64 { E_SEQ_REPLAY }
/// blob_ids length does not match the declared event count.
public fun len_mismatch(): u64 { E_LEN_MISMATCH }
/// Attempted to mutate a policy flagged immutable.
public fun policy_immutable(): u64 { E_POLICY_IMMUTABLE }
/// Attempted to mutate a sealed namespace.
public fun namespace_sealed(): u64 { E_NAMESPACE_SEALED }
/// Engagement window has expired.
public fun engagement_expired(): u64 { E_ENGAGEMENT_EXPIRED }
/// Engagement has been revoked by the admin.
public fun engagement_revoked(): u64 { E_ENGAGEMENT_REVOKED }
/// Request falls outside the engagement scope (sender/type/time/identity).
public fun scope_mismatch(): u64 { E_SCOPE_MISMATCH }
/// WriterCap does not bind to the target namespace.
public fun unauthorized_writer(): u64 { E_UNAUTHORIZED_WRITER }
/// Merkle proof failed to reconstruct the committed root.
public fun invalid_merkle_proof(): u64 { E_INVALID_MERKLE_PROOF }
/// parent_batch_hash does not equal the on-chain chain head.
public fun parent_hash_mismatch(): u64 { E_PARENT_HASH_MISMATCH }
/// AdminCap does not bind to the target object (cross-tenant misuse).
public fun unauthorized(): u64 { E_UNAUTHORIZED }
/// Sequence/batch-size arithmetic would overflow.
public fun seq_overflow(): u64 { E_SEQ_OVERFLOW }
