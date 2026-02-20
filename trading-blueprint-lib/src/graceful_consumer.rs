//! Wraps `TangleConsumer` to gracefully handle duplicate-job submission errors.
//!
//! The Tangle producer can replay jobs whose results were already submitted on-chain.
//! Without this wrapper the `poll_flush` error propagates up and crashes the binary.
//! We catch known-recoverable revert patterns and log them as warnings instead.

use std::pin::Pin;
use std::task::{Context, Poll};

use blueprint_sdk::tangle::TangleConsumer;
use futures_util::Sink;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Recoverable error substrings emitted by the Tangle contracts when a result
/// has already been submitted for a given `callId`.
const RECOVERABLE_PATTERNS: &[&str] = &[
    "reverted",
    "JobAlreadyCompleted",
    "ResultAlreadySubmitted",
    "already completed",
    "already submitted",
];

/// A thin wrapper around [`TangleConsumer`] that converts known-recoverable
/// `poll_flush` errors into warnings instead of propagating them as fatal.
pub struct GracefulConsumer {
    inner: TangleConsumer,
}

impl GracefulConsumer {
    pub fn new(inner: TangleConsumer) -> Self {
        Self { inner }
    }
}

impl<Item> Sink<Item> for GracefulConsumer
where
    TangleConsumer: Sink<Item, Error = BoxError>,
{
    type Error = BoxError;

    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.inner).poll_ready(cx)
    }

    fn start_send(mut self: Pin<&mut Self>, item: Item) -> Result<(), Self::Error> {
        Pin::new(&mut self.inner).start_send(item)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        match Pin::new(&mut self.inner).poll_flush(cx) {
            Poll::Ready(Err(e)) => {
                let msg = e.to_string();
                if RECOVERABLE_PATTERNS.iter().any(|p| msg.contains(p)) {
                    tracing::warn!(error = %msg, "Ignoring recoverable consumer error (duplicate job result)");
                    Poll::Ready(Ok(()))
                } else {
                    Poll::Ready(Err(e))
                }
            }
            other => other,
        }
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.inner).poll_close(cx)
    }
}
