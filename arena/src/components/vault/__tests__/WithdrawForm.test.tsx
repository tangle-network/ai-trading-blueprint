import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WithdrawForm } from '../WithdrawForm';

const mocks = vi.hoisted(() => ({
  account: {
    address: '0xb607A500574fE29afb0d0681f1dC3E82f79f4877',
    isConnected: true,
    chainId: 998,
  },
  addTx: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  redeemInKind: vi.fn(),
  redeem: vi.fn(),
  requestRedeem: vi.fn(),
  readContract: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => mocks.account,
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock('@tangle-network/blueprint-ui', () => ({
  addTx: mocks.addTx,
  tangleJobsAbi: [],
}));

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  Button: ({ children, ...props }: any) => <button type="button" {...props}>{children}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
  CardHeader: ({ children }: any) => <div>{children}</div>,
  CardTitle: ({ children }: any) => <div>{children}</div>,
  Input: (props: any) => <input {...props} />,
}));

vi.mock('~/lib/contracts/chainClients', () => ({
  getChainPublicClient: () => ({
    readContract: mocks.readContract,
  }),
}));

vi.mock('~/lib/hooks/useVaultWrite', () => ({
  useRedeemInKind: () => ({
    redeemInKind: mocks.redeemInKind,
    isPending: false,
    isConfirming: false,
    isSuccess: false,
    error: undefined,
    receiptError: undefined,
    reset: vi.fn(),
  }),
  useRedeem: () => ({
    redeem: mocks.redeem,
    isPending: false,
    isConfirming: false,
    isSuccess: false,
    error: undefined,
    receiptError: undefined,
    reset: vi.fn(),
  }),
  useRequestRedeem: () => ({
    requestRedeem: mocks.requestRedeem,
    isPending: false,
    isConfirming: false,
    isSuccess: false,
    error: undefined,
    receiptError: undefined,
    reset: vi.fn(),
  }),
}));

const baseProps = {
  vaultAddress: '0xba00751c4fb5855661efdabed2a09fe2068ff2cf' as const,
  assetSymbol: 'USDC',
  assetDecimals: 6,
  shareDecimals: 6,
  userShares: 5_000_000n,
  userSharesFormatted: 5,
  paused: false,
  targetChainName: 'HyperEVM Testnet',
  onSuccess: vi.fn(),
};

describe('WithdrawForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.account.address = '0xb607A500574fE29afb0d0681f1dC3E82f79f4877';
    mocks.account.isConnected = true;
    mocks.account.chainId = 998;
    mocks.readContract.mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === 'previewRedeem') return Promise.resolve(2_000_000n);
      if (functionName === 'maxRedeem') return Promise.resolve(1_000_000n);
      if (functionName === 'previewRedeemInKind') {
        return Promise.resolve([
          ['0x2B3370eE501B4a559b57D449569354196457D8Ab'],
          [2_000_000n],
        ]);
      }
      if (functionName === 'symbol') return Promise.resolve('USDC');
      if (functionName === 'decimals') return Promise.resolve(6);
      return Promise.resolve(undefined);
    });
  });

  it('queues HyperEVM withdrawals instead of submitting basket redeemInKind', async () => {
    render(<WithdrawForm {...baseProps} targetChainId={998} />);

    fireEvent.change(screen.getByLabelText('Shares'), { target: { value: '2' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Request Withdrawal' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request Withdrawal' }));

    expect(mocks.requestRedeem).toHaveBeenCalledWith(
      baseProps.vaultAddress,
      '2',
      6,
      998,
      expect.any(Object),
    );
    expect(mocks.redeemInKind).not.toHaveBeenCalled();
    expect(mocks.readContract).not.toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'previewRedeemInKind' }),
    );
  });

  it('keeps the basket withdrawal path for non-HyperEVM vaults', async () => {
    mocks.account.chainId = 31338;
    render(<WithdrawForm {...baseProps} targetChainId={31338} targetChainName="Ethereum Local Fork" />);

    fireEvent.change(screen.getByLabelText('Shares'), { target: { value: '2' } });

    await waitFor(() => {
      expect(mocks.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'previewRedeemInKind' }),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw Basket' }));

    expect(mocks.redeemInKind).toHaveBeenCalledWith(
      baseProps.vaultAddress,
      '2',
      6,
      31338,
      expect.any(Object),
    );
    expect(mocks.requestRedeem).not.toHaveBeenCalled();
    expect(mocks.redeem).not.toHaveBeenCalled();
  });
});
