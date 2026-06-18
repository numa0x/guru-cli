import type { PrefixTx, SimulateSwapResult, SwapSimulator } from '@guru-fund/sdk'
import compareAddresses from '@guru-fund/sdk/internal/helpers/compareAddresses'
import { Network, Tenderly, type TransactionParameters } from '@tenderly/sdk'
import { type Provider, type TransactionRequest } from 'ethers'

import { ERC20_INTERFACE } from './abi'

type AlchemyBundleTransaction = { from: string; to: string; data: string }
type SimulationLog = { address: string; data: string; topics: string[] }
type SimulationProviderName = 'alchemy' | 'tenderly'

const ALCHEMY_BUNDLE_MAX = 5
const RATE_LIMIT_MAX_RETRIES = 16
const RETRY_BASE_DELAY_MS = 500

const ALCHEMY_BASE_URL = {
    1: 'https://eth-mainnet.g.alchemy.com/v2',
    8453: 'https://base-mainnet.g.alchemy.com/v2',
} as const

const ZERO_GAS = {
    gas: 0,
    gas_price: '0',
    value: '0',
} as const

type AlchemySimulationResult = {
    calls: Array<{ error?: string | null; revertReason?: string | null }>
    logs: SimulationLog[]
    error?: string | null
    revertReason?: string | null
}

type TenderlyBundleResult = {
    status?: boolean
    logs?: Array<{
        raw?: {
            address?: string
            data: string
            topics: string[]
        }
    }>
    trace?: Array<{ error?: string | null; error_reason?: string | null }>
}

type SimulationStats = {
    routeProviders: Set<SimulationProviderName>
    txProviders: Set<SimulationProviderName>
}

type SimulationToolkit = {
    canSimulate: boolean
    describeConfiguredProviders: () => string
    simulator: SwapSimulator
    simulateQuoteTransaction: <T>(
        txData: TransactionRequest,
        decodeLogs: (logs: SimulationLog[]) => T | null,
        prelude?: AlchemyBundleTransaction
    ) => Promise<T | null>
    stats: SimulationStats
}

function getSimulationConfig() {
    const alchemyApiKey = process.env.ALCHEMY_API_KEY
    const tenderlyAccessToken = process.env.TENDERLY_ACCESS_TOKEN
    const tenderlyAccountName = process.env.TENDERLY_ACCOUNT_NAME
    const tenderlyProjectName = process.env.TENDERLY_PROJECT_NAME

    const hasTenderlyFields = [
        tenderlyAccessToken,
        tenderlyAccountName,
        tenderlyProjectName,
    ].filter(Boolean).length

    if (hasTenderlyFields > 0 && hasTenderlyFields < 3) {
        throw new Error(
            'Incomplete Tenderly configuration. Set TENDERLY_ACCESS_TOKEN, TENDERLY_ACCOUNT_NAME, and TENDERLY_PROJECT_NAME together.'
        )
    }

    return {
        alchemyApiKey,
        tenderly:
            hasTenderlyFields === 3
                ? {
                      accessToken: tenderlyAccessToken!,
                      accountName: tenderlyAccountName!,
                      projectName: tenderlyProjectName!,
                  }
                : null,
    }
}

async function retryWithIncrementalDelay<T>(
    operation: () => Promise<T>,
    maxRetries: number,
    baseDelayMs: number,
    shouldRetry: (error: unknown) => boolean
): Promise<T> {
    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation()
        } catch (error) {
            lastError = error
            if (attempt === maxRetries || !shouldRetry(error)) {
                throw error
            }
            const delay = baseDelayMs * (attempt + 1)
            await new Promise((resolve) => setTimeout(resolve, delay))
        }
    }

    throw lastError
}

/**
 * Alchemy tracer infra-errors (e.g. `ReferenceError: bigInt is not defined`
 * on transient-storage-heavy traces like Uniswap V4 swaps) are reported in
 * the same `error` field as genuine EVM reverts. They mean "Alchemy could
 * not evaluate", not "the transaction failed" — callers should fall through
 * to Tenderly instead of reporting a failed simulation.
 */
function isSimulatorInfraError(message: string): boolean {
    return /ReferenceError|TypeError|SyntaxError|is not defined|internal error/i.test(
        message
    )
}

function isRateLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    const lower = message.toLowerCase()
    return (
        lower.includes('429') ||
        lower.includes('too many requests') ||
        lower.includes('compute units per second')
    )
}

function createTenderlyClient(chainId: number): Tenderly {
    const config = getSimulationConfig().tenderly
    if (!config) {
        throw new Error('Tenderly is not configured')
    }
    return new Tenderly({
        accountName: config.accountName,
        projectName: config.projectName,
        accessKey: config.accessToken,
        network: chainId as Network,
    })
}

async function callAlchemyBundle(
    chainId: number,
    transactions: AlchemyBundleTransaction[]
): Promise<AlchemySimulationResult[]> {
    const apiKey = getSimulationConfig().alchemyApiKey
    if (!apiKey) throw new Error('ALCHEMY_API_KEY is not set')
    const baseUrl = ALCHEMY_BASE_URL[chainId as keyof typeof ALCHEMY_BASE_URL]
    if (!baseUrl) {
        throw new Error(
            `Alchemy bundle simulation unsupported on chainId ${chainId}`
        )
    }

    const response = await fetch(`${baseUrl}/${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'alchemy_simulateExecutionBundle',
            params: [transactions],
        }),
    })
    const json = (await response.json()) as {
        result?: AlchemySimulationResult[]
        error?: { message: string }
    }
    if (json.error) {
        throw new Error(json.error.message)
    }
    if (!json.result) {
        throw new Error('Empty result in Alchemy simulation response')
    }
    return json.result
}

async function simulateSwapWithAlchemy(params: {
    chainId: number
    from: string
    to: string
    callData: string
    account: string
    amountIn: bigint
    tokenIn: string
    prefixTxs?: PrefixTx[]
}): Promise<SimulateSwapResult | null> {
    const isDeposit = !compareAddresses(params.account, params.to)
    const prefixBundle = (params.prefixTxs ?? []).map((prefix) => ({
        from: prefix.from,
        to: prefix.to,
        data: prefix.callData,
    }))

    const transactions: AlchemyBundleTransaction[] = [...prefixBundle]

    if (isDeposit) {
        transactions.push({
            from: params.account,
            to: params.tokenIn,
            data: ERC20_INTERFACE.encodeFunctionData('transfer', [
                params.to,
                params.amountIn,
            ]),
        })
    }

    transactions.push({
        from: params.from,
        to: params.to,
        data: params.callData,
    })

    if (transactions.length > ALCHEMY_BUNDLE_MAX) {
        return null
    }

    try {
        const result = await retryWithIncrementalDelay(
            () => callAlchemyBundle(params.chainId, transactions),
            RATE_LIMIT_MAX_RETRIES,
            RETRY_BASE_DELAY_MS,
            isRateLimitError
        )

        for (let i = 0; i < prefixBundle.length; i++) {
            const failure = result[i]?.error ?? result[i]?.revertReason
            if (failure) {
                return {
                    success: false,
                    revertMessage: `prefix tx ${i} reverted: ${failure}`,
                }
            }
        }

        const target = result[result.length - 1]
        if (!target) {
            throw new Error('Missing swap result in Alchemy bundle response')
        }
        const topLevelError = target.error ?? target.revertReason
        const callLevelError =
            target.calls[0]?.error ?? target.calls[0]?.revertReason
        const failure = topLevelError ?? callLevelError

        if (failure && isSimulatorInfraError(failure)) {
            return null // Alchemy could not evaluate — let Tenderly try
        }

        return {
            success: !failure,
            revertMessage: failure ?? undefined,
        }
    } catch {
        return null
    }
}

async function simulateSwapWithTenderly(params: {
    chainId: number
    from: string
    to: string
    callData: string
    blockNumber: number
    account: string
    amountIn: bigint
    tokenIn: string
    prefixTxs?: PrefixTx[]
}): Promise<SimulateSwapResult> {
    const tenderly = createTenderlyClient(params.chainId)
    const isDeposit = !compareAddresses(params.account, params.to)

    const transactions: TransactionParameters[] = (params.prefixTxs ?? []).map(
        (prefix) => ({
            from: prefix.from,
            to: prefix.to,
            input: prefix.callData,
            ...ZERO_GAS,
        })
    )

    if (isDeposit) {
        transactions.push({
            from: params.account,
            to: params.tokenIn,
            input: ERC20_INTERFACE.encodeFunctionData('transfer', [
                params.to,
                params.amountIn,
            ]),
            ...ZERO_GAS,
        })
    }

    transactions.push({
        from: params.from,
        to: params.to,
        input: params.callData,
        ...ZERO_GAS,
    })

    try {
        const result = await retryWithIncrementalDelay(
            () =>
                tenderly.simulator.simulateBundle({
                    transactions,
                    blockNumber: params.blockNumber,
                }),
            RATE_LIMIT_MAX_RETRIES,
            RETRY_BASE_DELAY_MS,
            isRateLimitError
        )

        const prefixCount = params.prefixTxs?.length ?? 0
        for (let i = 0; i < prefixCount; i++) {
            const prefixResult = result?.[i]
            if (!(prefixResult?.status ?? false)) {
                const reason = prefixResult?.trace?.find(
                    (trace) => trace.error ?? trace.error_reason
                )
                return {
                    success: false,
                    revertMessage: `prefix tx ${i} reverted${reason ? `: ${reason.error ?? reason.error_reason}` : ''}`,
                }
            }
        }

        const target = result?.[result.length - 1]
        const reason = target?.trace?.find(
            (trace) => trace.error ?? trace.error_reason
        )
        return {
            success: target?.status ?? false,
            revertMessage: reason?.error ?? reason?.error_reason ?? undefined,
        }
    } catch (error) {
        return {
            success: false,
            revertMessage:
                error instanceof Error ? error.message : String(error),
        }
    }
}

async function simulateBundleWithAlchemy(
    chainId: number,
    transactions: AlchemyBundleTransaction[]
): Promise<SimulationLog[] | null> {
    if (transactions.length > ALCHEMY_BUNDLE_MAX) return null

    try {
        const result = await retryWithIncrementalDelay(
            () => callAlchemyBundle(chainId, transactions),
            RATE_LIMIT_MAX_RETRIES,
            RETRY_BASE_DELAY_MS,
            isRateLimitError
        )
        const target = result[result.length - 1]
        if (!target || target.error || target.revertReason) return null
        return target.logs
    } catch {
        return null
    }
}

async function simulateBundleWithTenderly(
    chainId: number,
    transactions: AlchemyBundleTransaction[],
    blockNumber: number
): Promise<SimulationLog[] | null> {
    const tenderly = createTenderlyClient(chainId)
    const tenderlyTransactions: TransactionParameters[] = transactions.map(
        (transaction) => ({
            from: transaction.from,
            to: transaction.to,
            input: transaction.data,
            ...ZERO_GAS,
        })
    )

    try {
        const result = await retryWithIncrementalDelay(
            () =>
                tenderly.simulator.simulateBundle({
                    transactions: tenderlyTransactions,
                    blockNumber,
                }),
            RATE_LIMIT_MAX_RETRIES,
            RETRY_BASE_DELAY_MS,
            isRateLimitError
        )
        const target = result?.[result.length - 1] as
            | TenderlyBundleResult
            | undefined
        if (!(target?.status ?? false)) return null
        return (
            target?.logs
                ?.map((log) => log.raw)
                .filter((log): log is NonNullable<typeof log> => !!log)
                .map((log) => ({
                    address: log.address ?? '',
                    data: log.data,
                    topics: log.topics,
                })) ?? []
        )
    } catch {
        return null
    }
}

function txToBundleTransaction(
    tx: TransactionRequest
): AlchemyBundleTransaction {
    const from = typeof tx.from === 'string' ? tx.from : String(tx.from ?? '')
    const to = typeof tx.to === 'string' ? tx.to : String(tx.to ?? '')
    const data = typeof tx.data === 'string' ? tx.data : '0x'

    if (!from || !to) {
        throw new Error(
            'Transaction request must include string from/to fields'
        )
    }

    return { from, to, data }
}

export function createSimulationToolkit(
    chainId: number,
    provider: Provider
): SimulationToolkit {
    const config = getSimulationConfig()
    const stats: SimulationStats = {
        routeProviders: new Set<SimulationProviderName>(),
        txProviders: new Set<SimulationProviderName>(),
    }

    const configuredProviders: SimulationProviderName[] = []
    if (config.alchemyApiKey) configuredProviders.push('alchemy')
    if (config.tenderly) configuredProviders.push('tenderly')

    const simulator: SwapSimulator = async ({
        chainId: requestChainId,
        from,
        to,
        callData,
        blockNumber,
        account,
        amountIn,
        tokenIn,
        prefixTxs,
    }) => {
        const alchemyResult = config.alchemyApiKey
            ? await simulateSwapWithAlchemy({
                  chainId: requestChainId,
                  from,
                  to,
                  callData,
                  account,
                  amountIn,
                  tokenIn,
                  prefixTxs,
              })
            : null

        if (alchemyResult !== null) {
            stats.routeProviders.add('alchemy')
            return alchemyResult
        }

        if (config.tenderly) {
            stats.routeProviders.add('tenderly')
            return simulateSwapWithTenderly({
                chainId: requestChainId,
                from,
                to,
                callData,
                blockNumber,
                account,
                amountIn,
                tokenIn,
                prefixTxs,
            })
        }

        return {
            success: false,
            revertMessage: 'No simulation provider configured',
        }
    }

    async function simulateQuoteTransaction<T>(
        txData: TransactionRequest,
        decodeLogs: (logs: SimulationLog[]) => T | null,
        prelude?: AlchemyBundleTransaction
    ): Promise<T | null> {
        if (configuredProviders.length === 0) return null

        const transactions = [prelude, txToBundleTransaction(txData)].filter(
            (entry): entry is AlchemyBundleTransaction => !!entry
        )

        const alchemyLogs = config.alchemyApiKey
            ? await simulateBundleWithAlchemy(chainId, transactions)
            : null

        if (alchemyLogs) {
            stats.txProviders.add('alchemy')
            return decodeLogs(alchemyLogs)
        }

        if (config.tenderly) {
            const blockNumber = await provider.getBlockNumber()
            const tenderlyLogs = await simulateBundleWithTenderly(
                chainId,
                transactions,
                blockNumber
            )
            if (tenderlyLogs) {
                stats.txProviders.add('tenderly')
                return decodeLogs(tenderlyLogs)
            }
        }

        return null
    }

    return {
        canSimulate: configuredProviders.length > 0,
        describeConfiguredProviders: () =>
            configuredProviders.length > 0
                ? configuredProviders.join('+')
                : 'none',
        simulator,
        simulateQuoteTransaction,
        stats,
    }
}

export function buildDepositApprovalPrelude(
    account: string,
    coin: string,
    spender: string,
    amount: bigint
): AlchemyBundleTransaction {
    return {
        from: account,
        to: coin,
        data: ERC20_INTERFACE.encodeFunctionData('approve', [spender, amount]),
    }
}

export function summarizeProviders(
    providers: Set<SimulationProviderName>
): string {
    return providers.size > 0 ? [...providers].join('+') : 'none'
}

export function getConfiguredSimulationProviderCount(): number {
    const config = getSimulationConfig()
    return (
        Number(Boolean(config.alchemyApiKey)) + Number(Boolean(config.tenderly))
    )
}
