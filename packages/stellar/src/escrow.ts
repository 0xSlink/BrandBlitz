import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Server as HorizonServer } from "@stellar/stellar-sdk/lib/horizon";
import { Server as SorobanServer } from "@stellar/stellar-sdk/lib/soroban";
import { withRetry, type RetryOptions } from "./client";

export interface EscrowRecipient {
  address: string;
  amountStroops: bigint;
}

export interface EscrowConfig {
  contractId: string;
  horizonUrl: string;
  sorobanUrl: string;
  networkPassphrase: string;
}

/**
 * Builds the ScVal key for a unit variant of the contract's `#[contracttype] enum DataKey`.
 * soroban-sdk encodes unit variants as a one-element vector holding the variant name.
 */
function dataKeyUnitVariant(name: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);
}

/**
 * Turns a failed transaction simulation into an error that names the operation and,
 * for authorization failures, says which party did not authorise the call.
 */
function explainSimulationError(operation: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/require_auth|authoriz|authoris|\bauth\b/i.test(message)) {
    return new Error(`${operation} rejected: the admin did not authorise this call (${message})`);
  }
  return new Error(`${operation} simulation failed: ${message}`);
}

/**
 * Soroban Escrow Contract Wrapper
 *
 * Wraps initialize, deposit, settle, and refund calls to the USDC escrow contract.
 * The contract holds prize pools atomically and distributes to winners on settlement.
 */
export class EscrowClient {
  private contract: Contract;
  private horizonServer: HorizonServer;
  private sorobanServer: SorobanServer;
  private networkPassphrase: string;

  constructor(config: EscrowConfig) {
    this.contract = new Contract(config.contractId);
    this.horizonServer = new HorizonServer(config.horizonUrl);
    this.sorobanServer = new SorobanServer(config.sorobanUrl);
    this.networkPassphrase = config.networkPassphrase;
  }

  /**
   * Initialize the escrow contract for a challenge.
   * Called once per challenge to set up the contract instance.
   *
   * Authorization: the contract's `initialize` does not call `require_auth`, so no
   * authorization entry is attached. The signer only pays the fee.
   *
   * @param admin - BrandBlitz hot-wallet address (authorized to settle/refund)
   * @param usdcTokenAddress - USDC SAC contract address on this network
   * @param memo - Challenge ID (unique identifier for this escrow)
   * @param signerSecret - Hot-wallet secret key for signing
   */
  async initialize(
    admin: string,
    usdcTokenAddress: string,
    memo: string,
    signerSecret: string
  ): Promise<string> {
    const signer = Keypair.fromSecret(signerSecret);
    const account = await this.horizonServer.loadAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: this.contract.call(
            "initialize",
            new Address(admin).toScVal(),
            new Address(usdcTokenAddress).toScVal(),
            nativeToScVal(memo, { type: "string" })
          ),
          auth: [],
        })
      )
      .setTimeout(300)
      .build();

    tx.sign(signer);
    const result = await withRetry(() => this.sorobanServer.sendTransaction(tx), {
      maxAttempts: 5,
      baseDelayMs: 250,
      maxDelayMs: 30_000,
    });

    if (result.status === "ERROR") {
      throw new Error(`Initialize failed: ${result.error_details}`);
    }

    return result.hash;
  }

  /**
   * Deposit USDC into the escrow contract.
   * Called by the brand to fund the prize pool.
   *
   * Authorization: the depositor must sign (`depositor.require_auth()` on the contract),
   * so an explicit address credential is attached.
   *
   * @param depositor - Brand address (must have approved USDC for contract)
   * @param amountStroops - Amount in stroops (1 USDC = 10^7 stroops)
   * @param signerSecret - Depositor's secret key for signing
   */
  async deposit(depositor: string, amountStroops: bigint, signerSecret: string): Promise<string> {
    const signer = Keypair.fromSecret(signerSecret);
    const account = await this.horizonServer.loadAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: this.contract.call(
            "deposit",
            new Address(depositor).toScVal(),
            nativeToScVal(Number(amountStroops), { type: "i128" })
          ),
          auth: [
            {
              credentials: xdr.SorobanCredentials.sorobanAddressCredentials(
                new Address(depositor).toScVal(),
                BigInt(0),
                xdr.Int64.fromString("0"),
                xdr.SignerKey.signerKeyTypeEd25519(Keypair.fromSecret(signerSecret).rawPublicKey()),
                xdr.Int64.fromString("0"),
                xdr.SorobanSignaturePayload.sorobanSignaturePayloadEnvelope(
                  xdr.EnvelopeTypeTx.txTypeTransaction(),
                  xdr.TransactionEnvelope.txTypeV0(
                    xdr.TransactionV0Envelope.create({
                      tx: xdr.TransactionV0.create({
                        sourceAccountEd25519: Keypair.fromSecret(signerSecret).rawPublicKey(),
                        fee: 100000,
                        seqNum: xdr.SequenceNumber.create(BigInt(0)),
                        timeBounds: xdr.TimeBounds.create({
                          minTime: xdr.Uint64.fromString("0"),
                          maxTime: xdr.Uint64.fromString("0"),
                        }),
                        memo: xdr.Memo.memoNone(),
                        operations: [],
                        ext: xdr.TransactionV0Ext.v0(),
                      }),
                      signatures: [],
                    })
                  )
                )
              ),
            },
          ],
        })
      )
      .setTimeout(300)
      .build();

    tx.sign(signer);
    const result = await withRetry(() => this.sorobanServer.sendTransaction(tx), {
      maxAttempts: 5,
      baseDelayMs: 250,
      maxDelayMs: 30_000,
    });

    if (result.status === "ERROR") {
      throw new Error(`Deposit failed: ${result.error_details}`);
    }

    return result.hash;
  }

  /**
   * Settle the escrow by distributing USDC to winners.
   * Called by the backend after challenge ends to pay out winners.
   *
   * Authorization: the contract calls `admin.require_auth()`. The transaction is simulated
   * and prepared before signing, so the auth entry for the admin is filled in from the
   * simulation. If the admin does not authorise the call, this throws a readable error
   * instead of the generic "Settle failed".
   *
   * @param recipients - Array of (address, amountStroops) pairs
   * @param signerSecret - Hot-wallet secret key for signing
   */
  async settle(recipients: EscrowRecipient[], signerSecret: string): Promise<string> {
    const signer = Keypair.fromSecret(signerSecret);
    const account = await this.horizonServer.loadAccount(signer.publicKey());

    // Convert recipients to Soroban format
    const recipientScVals = recipients.map((r) =>
      nativeToScVal([new Address(r.address).toScVal(), Number(r.amountStroops)], { type: "vec" })
    );

    const tx = new TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: this.contract.call("settle", nativeToScVal(recipientScVals, { type: "vec" })),
          auth: [],
        })
      )
      .setTimeout(300)
      .build();

    // Simulate first: prepareTransaction fills in the admin's authorization entry and the
    // resource footprint. Not retried, because a simulation failure is deterministic.
    const prepared = await this.sorobanServer
      .prepareTransaction(tx)
      .catch((e: unknown) => {
        throw explainSimulationError("Settle", e);
      });

    prepared.sign(signer);
    const result = await withRetry(() => this.sorobanServer.sendTransaction(prepared), {
      maxAttempts: 5,
      baseDelayMs: 250,
      maxDelayMs: 30_000,
    });

    if (result.status === "ERROR") {
      throw new Error(`Settle failed: ${result.error_details}`);
    }

    return result.hash;
  }

  /**
   * Refund the full balance back to the depositor.
   * Called by admin for cancelled challenges.
   *
   * Authorization: the contract calls `admin.require_auth()`. This is not yet prepared
   * by simulation, so it has the same limitation `settle` had before (tracked separately).
   *
   * @param signerSecret - Admin hot-wallet secret key for signing
   */
  async refund(signerSecret: string): Promise<string> {
    const signer = Keypair.fromSecret(signerSecret);
    const account = await this.horizonServer.loadAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: this.contract.call("refund"),
          auth: [],
        })
      )
      .setTimeout(300)
      .build();

    tx.sign(signer);
    const result = await withRetry(() => this.sorobanServer.sendTransaction(tx), {
      maxAttempts: 5,
      baseDelayMs: 250,
      maxDelayMs: 30_000,
    });

    if (result.status === "ERROR") {
      throw new Error(`Refund failed: ${result.error_details}`);
    }

    return result.hash;
  }

  /**
   * Reads a `DataKey` value. The contract writes these to instance storage, which is
   * held inside the contract-instance ledger entry rather than under its own key. A
   * per-key lookup therefore never finds them. Returns null when the key is unset.
   */
  private async readInstanceValue(variant: string): Promise<xdr.ScVal | null> {
    const instance = await withRetry(
      () =>
        this.sorobanServer.getContractData(
          this.contract.address().contractId(),
          xdr.ScVal.scvLedgerKeyContractInstance()
        ),
      { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5_000 }
    );

    if (!instance) {
      return null;
    }

    const storage = instance.val.instance().storage();
    if (!storage) {
      return null;
    }

    const wanted = dataKeyUnitVariant(variant).toXDR("base64");
    const entry = storage.find((e) => e.key().toXDR("base64") === wanted);
    return entry ? entry.val() : null;
  }

  /**
   * View: Get the current escrowed balance.
   */
  async getBalance(): Promise<bigint> {
    const value = await this.readInstanceValue("Balance");
    if (!value) {
      return 0n;
    }

    return BigInt(scValToNative(value) as number | bigint);
  }

  /**
   * View: Check if the escrow has been settled or refunded.
   */
  async isSettled(): Promise<boolean> {
    const value = await this.readInstanceValue("Settled");
    if (!value) {
      return false;
    }

    return scValToNative(value) as boolean;
  }

  /**
   * View: Get the challenge memo string (returns empty string if uninitialized).
   */
  async getMemo(): Promise<string> {
    const value = await this.readInstanceValue("Memo");
    if (!value) {
      return "";
    }

    return scValToNative(value) as string;
  }

  /**
   * Generate unsigned XDR for admin operations without submitting.
   * External signers review and co-sign offline before submission.
   *
   * @param operation - "withdraw" | "close_escrow" | "distribute"
   * @param operationData - Operation-specific parameters
   * @param adminSecret - Admin/hot-wallet secret for signing
   * @returns { xdrUnsigned, operationHash } for external co-signing
   */
  async generateAdminOperationXdr(
    operation: "withdraw" | "close_escrow" | "distribute",
    operationData: Record<string, unknown>,
    adminSecret: string
  ): Promise<{ xdrUnsigned: string; operationHash: string }> {
    const { createHash } = await import("crypto");
    const signer = Keypair.fromSecret(adminSecret);
    const account = await this.horizonServer.loadAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: this.networkPassphrase,
    });

    // Build operation based on type
    if (operation === "withdraw") {
      // The escrow contract has no withdraw entrypoint. The previous classic self-payment
      // never touched escrowed funds and used the public network's USDC issuer on every
      // network. Fail closed until the contract gains a real withdraw entrypoint.
      throw new Error("withdraw is not supported: the escrow contract has no withdraw entrypoint");
    } else if (operation === "close_escrow") {
      // Close escrow account and return reserves
      tx.addOperation(
        Operation.accountMerge({
          destination: signer.publicKey(),
        })
      );
    } else if (operation === "distribute") {
      // Distribute to multiple recipients (via Soroban call)
      const { recipients } = operationData as {
        recipients: Array<{ address: string; amount: bigint }>;
      };

      const recipientScVals = recipients.map((r) =>
        nativeToScVal([new Address(r.address).toScVal(), Number(r.amount)], { type: "vec" })
      );

      tx.addOperation(
        Operation.invokeHostFunction({
          func: this.contract.call("settle", nativeToScVal(recipientScVals, { type: "vec" })),
          auth: [],
        })
      );
    } else {
      throw new Error(`Unsupported admin operation: ${String(operation)}`);
    }

    const built = tx.setTimeout(300).build();

    // DO NOT SIGN YET - this is for external co-signers
    const xdrUnsigned = built.toEnvelope().toXDR("base64");

    // Hash for signing attestation
    const hash = createHash("sha256").update(xdrUnsigned, "utf-8").digest("hex");

    return { xdrUnsigned, operationHash: hash };
  }
}

export default EscrowClient;
