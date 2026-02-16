use alloy::primitives::U256;

use super::{ActionParams, EncodedAction, ProtocolAdapter};
use crate::error::TradingError;

/// Meta-adapter that wraps any protocol adapter and splits a single trade
/// into multiple time-delayed slices for TWAP execution.
pub struct TwapAdapter {
    /// The underlying adapter to delegate encoding to
    inner: Box<dyn ProtocolAdapter + Send + Sync>,
    /// Number of slices to split the trade into
    num_slices: u32,
    /// Interval between slices in seconds
    interval_secs: u64,
}

/// A single TWAP slice representing one portion of the total trade
#[derive(Debug, Clone)]
pub struct TwapSlice {
    /// The encoded action for this slice
    pub action: EncodedAction,
    /// Delay in seconds from the start of TWAP execution
    pub delay_secs: u64,
    /// Slice index (0-based)
    pub slice_index: u32,
    /// Total number of slices
    pub total_slices: u32,
}

impl TwapAdapter {
    pub fn new(
        inner: Box<dyn ProtocolAdapter + Send + Sync>,
        num_slices: u32,
        interval_secs: u64,
    ) -> Self {
        Self {
            inner,
            num_slices: num_slices.max(1),
            interval_secs,
        }
    }

    /// Split a trade into TWAP slices
    pub fn split_into_slices(
        &self,
        params: &ActionParams,
    ) -> Result<Vec<TwapSlice>, TradingError> {
        if self.num_slices == 0 {
            return Err(TradingError::ConfigError(
                "TWAP num_slices must be > 0".into(),
            ));
        }

        let mut slices = Vec::new();

        let total_amount: u128 = params
            .amount
            .try_into()
            .map_err(|_| TradingError::ConfigError("Amount too large for TWAP split".into()))?;

        let slice_amount = total_amount / self.num_slices as u128;
        let remainder = total_amount % self.num_slices as u128;

        let total_min: u128 = params.min_output.try_into().unwrap_or(0);
        let slice_min = total_min / self.num_slices as u128;

        for i in 0..self.num_slices {
            // Last slice gets the remainder
            let amount = if i == self.num_slices - 1 {
                slice_amount + remainder
            } else {
                slice_amount
            };

            let slice_params = ActionParams {
                action: params.action.clone(),
                token_in: params.token_in,
                token_out: params.token_out,
                amount: U256::from(amount),
                min_output: U256::from(slice_min),
                extra: params.extra.clone(),
            };

            let action = self.inner.encode_action(&slice_params)?;

            slices.push(TwapSlice {
                action,
                delay_secs: self.interval_secs * i as u64,
                slice_index: i,
                total_slices: self.num_slices,
            });
        }

        Ok(slices)
    }
}

impl ProtocolAdapter for TwapAdapter {
    fn protocol_id(&self) -> &str {
        "twap"
    }

    fn supported_chains(&self) -> Vec<u64> {
        self.inner.supported_chains()
    }

    /// Encodes only the first slice. Use `split_into_slices` for the full TWAP plan.
    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        let slices = self.split_into_slices(params)?;
        slices
            .into_iter()
            .next()
            .map(|s| s.action)
            .ok_or_else(|| TradingError::ConfigError("TWAP produced no slices".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::uniswap_v3::UniswapV3Adapter;
    use crate::types::Action;

    const TOKEN_A: &str = "0x0000000000000000000000000000000000000001";
    const TOKEN_B: &str = "0x0000000000000000000000000000000000000002";

    #[test]
    fn test_twap_split() {
        let inner = Box::new(UniswapV3Adapter::new());
        let twap = TwapAdapter::new(inner, 4, 60);

        let params = ActionParams {
            action: Action::Swap,
            token_in: TOKEN_A.parse().unwrap(),
            token_out: TOKEN_B.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(900_000u64),
            extra: serde_json::json!({"fee_tier": 3000}),
        };

        let slices = twap.split_into_slices(&params).unwrap();
        assert_eq!(slices.len(), 4);
        assert_eq!(slices[0].delay_secs, 0);
        assert_eq!(slices[1].delay_secs, 60);
        assert_eq!(slices[2].delay_secs, 120);
        assert_eq!(slices[3].delay_secs, 180);
    }

    #[test]
    fn test_twap_protocol_id() {
        let inner = Box::new(UniswapV3Adapter::new());
        let twap = TwapAdapter::new(inner, 3, 30);
        assert_eq!(twap.protocol_id(), "twap");
    }

    #[test]
    fn test_twap_inherits_chains() {
        let inner = Box::new(UniswapV3Adapter::new());
        let twap = TwapAdapter::new(inner, 3, 30);
        assert!(twap.supported_chains().contains(&42161));
    }
}
