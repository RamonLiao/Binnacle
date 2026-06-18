/// Retention / encryption / auditor-allowlist policy (spec §4.1, B4).
///
/// `PolicyObject` is NOT a standalone object — it is embedded *by value* inside
/// `AgentNamespace` (has `store, drop`, no `UID`) so the hot path can read its
/// fields directly without a dynamic load.
module compliance_vault::policy;

/// Encryption modes (spec §4.1).
const ENC_NONE: u8 = 0;
const ENC_ENVELOPE: u8 = 1;
const ENC_SEAL_THRESHOLD: u8 = 2;

/// Seal threshold config — k=2 / n=3 confirmed [A:1]. `key_server_ids` are Seal
/// key-server *object IDs* (SDK `serverConfigs[].objectId`), not URLs.
public struct SealConfig has store, copy, drop {
    k: u8,
    n: u8,
    key_server_ids: vector<ID>,
}

/// Embedded policy. `immutable` freezes further mutation independent of the
/// namespace `sealed` flag.
public struct PolicyObject has store, drop {
    retention_epochs: u64,
    encryption_mode: u8,
    seal_threshold: Option<SealConfig>,
    auditor_allowlist: vector<address>,
    immutable: bool,
}

/// Build a Seal threshold config.
public fun new_seal_config(k: u8, n: u8, key_server_ids: vector<ID>): SealConfig {
    SealConfig { k, n, key_server_ids }
}

/// Build a policy. `immutable` always starts false; seal it via the namespace.
public fun new_policy(
    retention_epochs: u64,
    encryption_mode: u8,
    seal_threshold: Option<SealConfig>,
    auditor_allowlist: vector<address>,
): PolicyObject {
    PolicyObject {
        retention_epochs,
        encryption_mode,
        seal_threshold,
        auditor_allowlist,
        immutable: false,
    }
}

public fun enc_none(): u8 { ENC_NONE }
public fun enc_envelope(): u8 { ENC_ENVELOPE }
public fun enc_seal_threshold(): u8 { ENC_SEAL_THRESHOLD }

public fun is_immutable(p: &PolicyObject): bool { p.immutable }
public fun retention_epochs(p: &PolicyObject): u64 { p.retention_epochs }
public fun encryption_mode(p: &PolicyObject): u8 { p.encryption_mode }
public fun auditor_allowlist(p: &PolicyObject): &vector<address> { &p.auditor_allowlist }
public fun seal_threshold(p: &PolicyObject): &Option<SealConfig> { &p.seal_threshold }

public fun seal_k(c: &SealConfig): u8 { c.k }
public fun seal_n(c: &SealConfig): u8 { c.n }
public fun seal_key_server_ids(c: &SealConfig): &vector<ID> { &c.key_server_ids }

/// Flip the policy to immutable. Package-internal: only `namespace::seal_namespace`
/// (and future migrations) may call it.
public(package) fun set_immutable(p: &mut PolicyObject) { p.immutable = true; }
