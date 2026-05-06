// Deprecated: use `crate::envelope` instead.
pub use crate::envelope::error::EnvelopeError as TradingError;
pub use crate::envelope::signed::{
    EnvelopeBinding, EnvelopeSignature, SignedEnvelope as SignedTradingEnvelope,
};
