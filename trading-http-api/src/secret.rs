//! Lightweight wrapper for sensitive values (private keys, tokens, passwords).
//!
//! Prevents accidental leakage via Debug/Display formatters. The raw value must
//! be accessed explicitly via `.expose()`, making audit-grepping easy.
//!
//! This is a minimal in-tree alternative to the `secrecy` crate to avoid adding
//! a dependency for a single type. If more sensitive types accumulate, replace
//! with `secrecy` in a future PR.

/// A value that is intentionally opaque to Debug/Display/serde output.
pub struct Secret<T>(T);

impl<T> Secret<T> {
    /// Wrap a value. The only way to construct a Secret.
    pub fn new(value: T) -> Self {
        Self(value)
    }

    /// Unwrap the raw value. Use sparingly — every caller is a potential leak.
    pub fn expose(&self) -> &T {
        &self.0
    }

    /// Consume the Secret and return the raw value.
    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T> std::fmt::Debug for Secret<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Secret(<redacted>)")
    }
}

impl<T> std::fmt::Display for Secret<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<redacted>")
    }
}

impl<T: Clone> Clone for Secret<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T> From<T> for Secret<T> {
    fn from(value: T) -> Self {
        Self::new(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_debug_redacted() {
        let secret = Secret::new("sk-super-secret".to_string());
        assert_eq!(format!("{secret:?}"), "Secret(<redacted>)");
    }

    #[test]
    fn test_display_redacted() {
        let secret = Secret::new("sk-super-secret".to_string());
        assert_eq!(format!("{secret}"), "<redacted>");
    }

    #[test]
    fn test_expose_returns_raw() {
        let secret = Secret::new("sk-super-secret".to_string());
        assert_eq!(secret.expose(), "sk-super-secret");
    }

    #[test]
    fn test_into_inner() {
        let secret = Secret::new("sk-super-secret".to_string());
        assert_eq!(secret.into_inner(), "sk-super-secret");
    }
}
