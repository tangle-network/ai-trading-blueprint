// Public surface
export { createVaultClient } from './client.js';
export type {
  VaultClient,
  VaultClientConfig,
  SwapArgs,
  LendArgs,
  WithdrawArgs,
  BorrowArgs,
  RepayArgs,
  PreparedTx,
} from './client.js';

// Validator interface + reference implementation
export { createLocalValidatorClient } from './validator/local.js';
export type { LocalValidator } from './validator/local.js';
export type { ValidatorClient, ValidatorRequest, ValidatorSignature } from './validator/types.js';

// Adapter contracts + mock implementations
export type {
  SwapAdapter,
  SwapIntent,
  SwapQuote,
  LendingAdapter,
  LendIntent,
  WithdrawIntent,
  BorrowIntent,
  RepayIntent,
  LendingPlan,
} from './adapters/types.js';
export {
  mockUniswapV3Adapter,
  mockPancakeswapV3Adapter,
  mockAerodromeAdapter,
  mockCurveAdapter,
  mockAaveAdapter,
  mockMorphoAdapter,
  deriveIntentHash,
} from './adapters/mock.js';
export type {
  UniswapV3MockConfig,
  PancakeV3MockConfig,
  AerodromeMockConfig,
  CurveMockConfig,
  AaveAdapterConfig,
  MorphoAdapterConfig,
} from './adapters/mock.js';

// Envelope + enforcement types (for power users / direct-shape consumers)
export type {
  Envelope,
  EnforcementKind,
  EnforcementVariant,
  ExecuteParams,
  HealthFactorParams,
  DebtReductionParams,
  UniswapV3SwapEnforcement,
  UniswapV4SwapEnforcement,
  AerodromeSwapEnforcement,
  PancakeswapV3SwapEnforcement,
  CurveStableSwapEnforcement,
  AaveSupplyEnforcement,
  AaveWithdrawEnforcement,
  AaveBorrowEnforcement,
  AaveRepayEnforcement,
  MorphoSupplyEnforcement,
  MorphoWithdrawEnforcement,
  MorphoBorrowEnforcement,
  MorphoRepayEnforcement,
} from './types/envelope.js';
export type {
  SwapProtocol,
  LendingProtocol,
  InterestRateMode,
} from './types/protocols.js';
export { SWAP_PROTOCOLS, LENDING_PROTOCOLS } from './types/protocols.js';

// Encoding helpers (low-level / debugging)
export {
  hashEnforcement,
  hashEnvelope,
  hashApprovalSigners,
  TYPE_HASHES,
  TYPE_STRINGS,
} from './encoding/enforcementHash.js';
export {
  encodeUniswapV3ExactInputSingle,
  encodePancakeswapV3ExactInputSingle,
  encodeAerodromeExactInputSingle,
  encodeCurveExchange,
  encodeAaveSupply,
  encodeAaveWithdraw,
  encodeAaveBorrow,
  encodeAaveRepay,
  encodeMorphoSupply,
  encodeMorphoWithdraw,
  encodeMorphoBorrow,
  encodeMorphoRepay,
} from './encoding/calldata.js';
export type { MorphoMarketParams } from './encoding/calldata.js';

// Raw escape hatch
export { RAW_API } from './raw.js';
export type { RawApi, RawCallParams } from './raw.js';

// ABI for callers that want to construct contract instances directly.
export { TRADING_VAULT_ABI } from './abi/tradingVault.js';
