//! Gateway API keys: `sk-` prefixed random tokens plus sha256 helpers,
//! matching the Electron `generateApiKey` format.

use sha2::{Digest, Sha256};

/// `sk-` + 32 hex chars (128-bit random). Same shape as the Electron app.
pub fn generate_api_key() -> String {
    format!("sk-{}", hex_lower(&uuid::Uuid::new_v4().into_bytes()[..]))
}

pub fn sha256_short(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    hex_lower(&digest[..8])
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Constant-time string compare without early-exit — mirrors the TS
/// `safeEqualString` so probing can't measure prefix length.
pub fn safe_equal(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    if a.len() != b.len() {
        return false;
    }
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_format() {
        let k = generate_api_key();
        assert!(k.starts_with("sk-"));
        assert_eq!(k.len(), 3 + 32);
    }

    #[test]
    fn equality() {
        assert!(safe_equal("sk-abc", "sk-abc"));
        assert!(!safe_equal("sk-abc", "sk-abd"));
        assert!(!safe_equal("sk-abc", "sk-abcd"));
    }
}
