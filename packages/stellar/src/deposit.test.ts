import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchDepositEvents,
  generateDepositMemo,
  getDepositConfirmationCount,
  validateDepositMemo,
} from "./deposit";
import { setLogger } from "./logger";
import * as client from "./client";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("./client", () => ({
  getRpcServer: vi.fn(),
  getUsdcAsset: vi.fn(),
  getNetworkConfig: vi.fn(),
  withRetry: vi.fn((fn) => fn()),
}));

beforeEach(() => {
  mocks.warn.mockReset();
  setLogger({ warn: mocks.warn });
});

afterEach(() => {
  setLogger(undefined);
});

describe("deposit memo generation", () => {
  it("creates unique Stellar-compatible text memos", () => {
    const first = generateDepositMemo();
    const second = generateDepositMemo();

    expect(first).not.toBe(second);
    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(28);
    expect(validateDepositMemo(first)).toEqual({ valid: true, memo: first });
    expect(validateDepositMemo(second)).toEqual({ valid: true, memo: second });
  });

  it("rejects memos that exceed Stellar's 28-byte text memo limit", () => {
    expect(validateDepositMemo("a".repeat(29))).toMatchObject({ valid: false });
  });
});

describe("fetchDepositEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the correct passphrase from networkConfig for testnet", async () => {
    const mockRpc = {
      getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 100 }),
    };
    const mockAsset = {
      contractId: vi.fn().mockReturnValue("mock-contract-id"),
    };

    vi.mocked(client.getRpcServer).mockReturnValue(mockRpc as any);
    vi.mocked(client.getUsdcAsset).mockReturnValue(mockAsset as any);
    vi.mocked(client.getNetworkConfig).mockReturnValue({
      networkPassphrase: "Test SDF Network ; September 2015",
    } as any);

    await fetchDepositEvents("hot-wallet", 1, "testnet");

    expect(client.getNetworkConfig).toHaveBeenCalledWith("testnet");
    expect(mockAsset.contractId).toHaveBeenCalledWith("Test SDF Network ; September 2015");
  });

  it("uses the correct passphrase from networkConfig for public", async () => {
    const mockRpc = {
      getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 100 }),
    };
    const mockAsset = {
      contractId: vi.fn().mockReturnValue("mock-contract-id"),
    };

    vi.mocked(client.getRpcServer).mockReturnValue(mockRpc as any);
    vi.mocked(client.getUsdcAsset).mockReturnValue(mockAsset as any);
    vi.mocked(client.getNetworkConfig).mockReturnValue({
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    } as any);

    await fetchDepositEvents("hot-wallet", 1, "public");

    expect(client.getNetworkConfig).toHaveBeenCalledWith("public");
    expect(mockAsset.contractId).toHaveBeenCalledWith(
      "Public Global Stellar Network ; September 2015"
    );
  });

  it("processes events with bounded concurrency and preserves their order", async () => {
    const txHashes = Array.from({ length: 12 }, (_, index) => `hash-${index}`);
    const events = txHashes.map((txHash, index) => ({
      txHash,
      ledger: 100 + index,
      ledgerClosedAt: "2024-01-01T00:00:00Z",
      value: 1000 + index,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];

    const mockRpc = {
      getEvents: vi.fn().mockResolvedValue({ events, latestLedger: 200 }),
      getTransaction: vi.fn(
        (txHash: string) =>
          new Promise((resolve) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            resolvers.push(() => {
              inFlight -= 1;
              resolve({ status: "SUCCESS", memo: { text: `memo-${txHash}` } });
            });
          })
      ),
    };

    vi.mocked(client.getRpcServer).mockReturnValue(mockRpc as any);
    vi.mocked(client.getUsdcAsset).mockReturnValue({ contractId: vi.fn() } as any);
    vi.mocked(client.getNetworkConfig).mockReturnValue({ networkPassphrase: "passphrase" } as any);

    const resultPromise = fetchDepositEvents("hot-wallet", 1, "testnet");

    await vi.waitFor(() => expect(mockRpc.getTransaction).toHaveBeenCalledTimes(10));
    expect(maxInFlight).toBe(10);

    for (const resolve of resolvers.splice(0).reverse()) resolve();

    await vi.waitFor(() => expect(mockRpc.getTransaction).toHaveBeenCalledTimes(12));
    for (const resolve of resolvers.splice(0).reverse()) resolve();

    const { events: deposits, latestLedger } = await resultPromise;

    expect(maxInFlight).toBe(10);
    expect(latestLedger).toBe(200);
    expect(deposits.map((deposit) => deposit.txHash)).toEqual(txHashes);
    expect(deposits.map((deposit) => deposit.memo)).toEqual(
      txHashes.map((txHash) => `memo-${txHash}`)
    );
    expect(deposits.map((deposit) => deposit.amount)).toEqual(
      txHashes.map((_, index) => String(1000 + index))
    );

    const perEventRetryOptions = vi
      .mocked(client.withRetry)
      .mock.calls.map(([, options]) => options)
      .filter((options) => options?.maxAttempts === 3);
    expect(perEventRetryOptions).toHaveLength(12);
    expect(perEventRetryOptions[0]).toEqual({
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 5_000,
    });
  });

  it("routes skipped, rejected, and failed deposits through the injected logger", async () => {
    const rawMemo = "x".repeat(40);
    const events = [
      { txHash: "tx-error", ledger: 100, ledgerClosedAt: "2024-01-01T00:00:00Z", value: 1 },
      { txHash: "tx-unsuccessful", ledger: 101, ledgerClosedAt: "2024-01-01T00:00:00Z", value: 1 },
      { txHash: "tx-no-ledger", ledger: 102, ledgerClosedAt: null, value: 1 },
      {
        txHash: "tx-bad-memo",
        ledger: 103,
        ledgerClosedAt: "2024-01-01T00:00:00Z",
        value: 1,
        from: "GSENDER",
      },
      { txHash: "tx-valid", ledger: 104, ledgerClosedAt: "2024-01-01T00:00:00Z", value: 1 },
    ];

    const mockRpc = {
      getEvents: vi.fn().mockResolvedValue({ events, latestLedger: 200 }),
      getTransaction: vi.fn((txHash: string) => {
        if (txHash === "tx-error") return Promise.reject(new Error("RPC error"));
        if (txHash === "tx-unsuccessful") return Promise.resolve({ status: "NOT_FOUND" });
        if (txHash === "tx-bad-memo") {
          return Promise.resolve({ status: "SUCCESS", memo: { text: rawMemo } });
        }
        return Promise.resolve({ status: "SUCCESS", memo: { text: "valid-memo" } });
      }),
    };

    vi.mocked(client.getRpcServer).mockReturnValue(mockRpc as any);
    vi.mocked(client.getUsdcAsset).mockReturnValue({ contractId: vi.fn() } as any);
    vi.mocked(client.getNetworkConfig).mockReturnValue({ networkPassphrase: "passphrase" } as any);

    const result = await fetchDepositEvents("hot-wallet", 1, "testnet");

    expect(mocks.warn).toHaveBeenCalledWith("Skipping unsuccessful transaction: tx-unsuccessful", {
      status: "NOT_FOUND",
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      "Skipping event with missing ledgerClosedAt: tx-no-ledger"
    );
    expect(mocks.warn).toHaveBeenCalledWith("Rejecting deposit with invalid memo", {
      reason: "invalid_format",
      memo: rawMemo.slice(0, 28),
      txHash: "tx-bad-memo",
      senderAccount: "GSENDER",
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      "Error processing deposit event tx-error:",
      expect.any(Error)
    );
    expect(mocks.warn.mock.calls.some(([, meta]) => meta?.memo === rawMemo)).toBe(false);
    expect(result.events.map((deposit) => deposit.txHash)).toEqual(["tx-valid"]);
  });
});

describe("getDepositConfirmationCount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calculates confirmations as current_ledger - tx_ledger", async () => {
    const mockRpc = {
      getTransaction: vi.fn().mockResolvedValue({
        status: "SUCCESS",
      }),
      getHealth: vi.fn().mockResolvedValue({
        ledger: { sequence: 1000 },
      }),
    };

    vi.mocked(client.getRpcServer).mockReturnValue(mockRpc as any);

    const confirmations = await getDepositConfirmationCount("abc123", 950, "testnet");

    expect(confirmations).toBe(50);
  });

  it("returns 0 if transaction not found", async () => {
    const mockRpc = {
      getTransaction: vi.fn().mockResolvedValue({
        status: "NOT_FOUND",
      }),
      getHealth: vi.fn().mockResolvedValue({
        ledger: { sequence: 1000 },
      }),
    };

    vi.mocked(client.getRpcServer).mockReturnValue(mockRpc as any);

    const confirmations = await getDepositConfirmationCount("abc123", 950, "testnet");

    expect(confirmations).toBe(0);
  });

  it("handles errors gracefully and returns 0", async () => {
    const mockRpc = {
      getTransaction: vi.fn().mockRejectedValue(new Error("RPC error")),
    };

    vi.mocked(client.getRpcServer).mockReturnValue(mockRpc as any);

    const confirmations = await getDepositConfirmationCount("abc123", 950, "testnet");

    expect(confirmations).toBe(0);
    expect(mocks.warn).toHaveBeenCalledWith(
      "Error checking deposit confirmations for abc123:",
      expect.any(Error)
    );
  });

  it("returns 0 when current ledger is less than tx ledger", async () => {
    const mockRpc = {
      getTransaction: vi.fn().mockResolvedValue({
        status: "SUCCESS",
      }),
      getHealth: vi.fn().mockResolvedValue({
        ledger: { sequence: 900 },
      }),
    };

    vi.mocked(client.getRpcServer).mockReturnValue(mockRpc as any);

    const confirmations = await getDepositConfirmationCount("abc123", 950, "testnet");

    expect(confirmations).toBe(0);
  });
});
