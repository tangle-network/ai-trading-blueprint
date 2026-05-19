use std::task::{Context, Poll};

use blueprint_sdk::core::JobCall;
use blueprint_sdk::core::metadata::{MetadataMap, MetadataValue};
use tower::{Layer, Service};

const EVM_CALL_ID: &str = "X-EVM-CALL-ID";
const EVM_SERVICE_ID: &str = "X-EVM-SERVICE-ID";
const EVM_JOB_INDEX: &str = "X-EVM-JOB-INDEX";
const EVM_BLOCK_NUMBER: &str = "X-EVM-BLOCK-NUMBER";
const EVM_BLOCK_HASH: &str = "X-EVM-BLOCK-HASH";
const EVM_TIMESTAMP: &str = "X-EVM-BLOCK-TIMESTAMP";
const EVM_CALLER: &str = "X-EVM-CALLER";

const TANGLE_CALL_ID: &str = "X-TANGLE-CALL-ID";
const TANGLE_SERVICE_ID: &str = "X-TANGLE-SERVICE-ID";
const TANGLE_JOB_INDEX: &str = "X-TANGLE-JOB-INDEX";
const TANGLE_BLOCK_NUMBER: &str = "X-TANGLE-BLOCK-NUMBER";
const TANGLE_BLOCK_HASH: &str = "X-TANGLE-BLOCK-HASH";
const TANGLE_TIMESTAMP: &str = "X-TANGLE-TIMESTAMP";
const TANGLE_CALLER: &str = "X-TANGLE-CALLER";

/// Adapts JobSubmitted calls from the EVM producer to the metadata keys used by
/// the Tangle extractors/layer. Keep this narrow: it only fills missing Tangle
/// keys and never overwrites metadata produced by a native Tangle producer.
#[derive(Clone, Debug)]
pub struct EvmTangleMetadataCompatLayer<L> {
    inner: L,
}

impl<L> EvmTangleMetadataCompatLayer<L> {
    pub const fn new(inner: L) -> Self {
        Self { inner }
    }
}

impl<L, S> Layer<S> for EvmTangleMetadataCompatLayer<L>
where
    L: Layer<S> + Clone,
{
    type Service = EvmTangleMetadataCompatService<L::Service>;

    fn layer(&self, service: S) -> Self::Service {
        EvmTangleMetadataCompatService {
            inner: self.inner.layer(service),
        }
    }
}

#[derive(Clone, Debug)]
pub struct EvmTangleMetadataCompatService<S> {
    inner: S,
}

impl<S> Service<JobCall> for EvmTangleMetadataCompatService<S>
where
    S: Service<JobCall>,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = S::Future;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, call: JobCall) -> Self::Future {
        let (mut parts, body) = call.into_parts();
        alias_evm_tangle_metadata(&mut parts.metadata);
        self.inner.call(JobCall::from_parts(parts, body))
    }
}

fn alias_metadata(metadata: &mut MetadataMap<MetadataValue>, from: &'static str, to: &'static str) {
    if metadata.get(to).is_some() {
        return;
    }

    if let Some(value) = metadata.get(from).cloned() {
        metadata.insert(to, value);
    }
}

pub(crate) fn alias_evm_tangle_metadata(metadata: &mut MetadataMap<MetadataValue>) {
    alias_metadata(metadata, EVM_CALL_ID, TANGLE_CALL_ID);
    alias_metadata(metadata, EVM_SERVICE_ID, TANGLE_SERVICE_ID);
    alias_metadata(metadata, EVM_JOB_INDEX, TANGLE_JOB_INDEX);
    alias_metadata(metadata, EVM_BLOCK_NUMBER, TANGLE_BLOCK_NUMBER);
    alias_metadata(metadata, EVM_BLOCK_HASH, TANGLE_BLOCK_HASH);
    alias_metadata(metadata, EVM_TIMESTAMP, TANGLE_TIMESTAMP);
    alias_metadata(metadata, EVM_CALLER, TANGLE_CALLER);

    if let (Some(call_id), Some(service_id)) = (
        read_u64_metadata(metadata, TANGLE_CALL_ID),
        read_u64_metadata(metadata, TANGLE_SERVICE_ID),
    ) {
        tracing::debug!(call_id, service_id, "Normalized EVM/Tangle job metadata");
    }
}

fn read_u64_metadata(metadata: &MetadataMap<MetadataValue>, key: &'static str) -> Option<u64> {
    metadata.get(key).and_then(|value| value.try_into().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_evm_metadata_without_overwriting_tangle_values() {
        let mut metadata = MetadataMap::new();
        metadata.insert(EVM_CALL_ID, 7u64);
        metadata.insert(EVM_SERVICE_ID, 3u64);
        metadata.insert(EVM_CALLER, [1u8; 20]);
        metadata.insert(TANGLE_SERVICE_ID, 99u64);

        alias_evm_tangle_metadata(&mut metadata);

        let call_id: u64 = metadata
            .get(TANGLE_CALL_ID)
            .expect("call id alias")
            .try_into()
            .expect("call id value");
        let service_id: u64 = metadata
            .get(TANGLE_SERVICE_ID)
            .expect("service id alias")
            .try_into()
            .expect("service id value");

        assert_eq!(call_id, 7);
        assert_eq!(service_id, 99);
        assert_eq!(
            metadata
                .get(TANGLE_CALLER)
                .expect("caller alias")
                .as_bytes(),
            &[1u8; 20]
        );
    }
}
