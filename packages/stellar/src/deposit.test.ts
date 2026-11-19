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
  });

  it("rejects memos that exceed Stellar's 28-byte text memo limit", () => {
    expect(validateDepositMemo("a".repeat(29))).toMatchObject({ valid: false });
  });
});

describe("validateDepositMemo", () => {
  it("accepts a valid v4 UUID", () => {
    const memo = "550e8400-e29b-41d4-a716-446655440000";
    expect(validateDepositMemo(memo)).toEqual({ valid: true, memo });
  });

  it("rejects a null memo as missing", () => {
    expect(validateDepositMemo(null)).toEqual({ valid: false, reason: "missing" });
  });

  it("rejects an empty memo as missing", () => {
    expect(validateDepositMemo("")).toEqual({ valid: false, reason: "missing" });
  });

  it("rejects a whitespace-only memo as missing", () => {
    expect(validateDepositMemo("   ")).toEqual({ valid: false, reason: "missing" });
  });

  it("rejects a non-UUID string as invalid_format", () => {
    expect(validateDepositMemo("not-a-deposit-memo")).toEqual({
      valid: false,
      reason: "invalid_format",
    });
  });

  it("accepts an uppercase v4 UUID", () => {
    const memo = "550E8400-E29B-41D4-A716-446655440000";
    expect(validateDepositMemo(memo)).toEqual({ valid: true, memo });
  });

  it("rejects a UUID with the wrong version nibble", () => {
    expect(validateDepositMemo("550e8400-e29b-11d4-a716-446655440000")).toEqual({
      valid: false,
      reason: "invalid_format",
    });
  });

  it("trims surrounding whitespace before validation", () => {
    const memo = "550e8400-e29b-41d4-a716-446655440000";
    expect(validateDepositMemo(`  ${memo}  `)).toEqual({ valid: true, memo });
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
