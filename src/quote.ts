import type { QuoteRebalanceTargetWeight } from '@guru-fund/sdk'
import { getGuruProtocolAddresses, GuruProtocol } from '@guru-fund/sdk'
import { Contract, getAddress, Interface, type Provider } from 'ethers'

import { LEDGER_INTERFACE } from './abi'
import { serializeJson, toPrivyRpcBody } from './serialize'
import {
    buildDepositApprovalPrelude,
    createSimulationToolkit,
    summarizeProviders,
} from './simulation'

type SharedQuoteArgs = {
    chainId: number
    rpcUrl: string
    fund: string
}

type DepositArgs = SharedQuoteArgs & {
    action: 'deposit'
    account: string
    coin: string
    amount: bigint
    referrerFeeBps: bigint
    slippageSettings?: Record<string, bigint>
}

type WithdrawalArgs = SharedQuoteArgs & {
    action: 'withdrawal'
    account: string
    shares: bigint
    coin: string
    referrerFeeBps: bigint
    slippageSettings?: Record<string, bigint>
}

type HarvestArgs = SharedQuoteArgs & {
    action: 'harvest'
    coin: string
    slippageSettings?: Record<string, bigint>
}

type CloseArgs = SharedQuoteArgs & {
    action: 'close'
    coin: string
    slippageSettings?: Record<string, bigint>
}

type TradeArgs = SharedQuoteArgs & {
    action: 'trade'
    tokenIn: string
    tokenOut: string
    amountIn: bigint
    maxSlippage?: bigint
}

type RebalanceArgs = SharedQuoteArgs & {
    action: 'rebalance'
    targetWeights: QuoteRebalanceTargetWeight[]
    slippageSettings?: Record<string, bigint>
}

export type QuoteCommandArgs =
    | DepositArgs
    | WithdrawalArgs
    | HarvestArgs
    | CloseArgs
    | TradeArgs
    | RebalanceArgs

type QuoteCommandResponse = {
    quote: Record<string, unknown>
    encoding: Record<string, unknown>
    tx: Record<string, unknown>
}

type ExternalCallLike = {
    adapter: unknown
    callData: unknown
}

const FUND_CONTROLLER_ABI = [
    'function harvest((address ledger,address coin,uint64 fraction,bool isManagementFeeEligible,(address adapter,bytes callData)[] extCalls))',
] as const

const FUND_CONTROLLER_INTERFACE = new Interface(FUND_CONTROLLER_ABI)

function normalizeExtCalls(extCalls: ExternalCallLike[]) {
    return extCalls.map((call) => ({
        adapter: String(call.adapter),
        callData: String(call.callData),
    }))
}

function lower(address: string): string {
    return getAddress(address).toLowerCase()
}

async function getLedgerAssets(
    provider: Provider,
    fund: string
): Promise<string[]> {
    const contract = new Contract(fund, LEDGER_INTERFACE, provider)
    const assets = (await contract.getAssets()) as string[]
    return assets.map((asset) => lower(asset))
}

function buildEncoding(params: {
    txData: { to?: unknown; from?: unknown }
    functionName: string
    abi: string[]
    args: unknown[]
}): Record<string, unknown> {
    return {
        contract: {
            name: 'FundController',
            address: params.txData.to,
        },
        from: params.txData.from,
        functionName: params.functionName,
        abi: params.abi,
        args: params.args,
    }
}

function getEncodedHarvestManagementFeeEligibility(data: unknown): boolean {
    const decoded = FUND_CONTROLLER_INTERFACE.decodeFunctionData(
        'harvest',
        typeof data === 'string' ? data : '0x'
    )
    const harvest = decoded[0] as { isManagementFeeEligible: boolean }
    return harvest.isManagementFeeEligible
}

function ensureSlippageCoverage(
    action: QuoteCommandArgs['action'],
    slippageSettings: Record<string, bigint> | undefined,
    requiredTokens: Iterable<string>
) {
    const settings = new Set(
        Object.keys(slippageSettings ?? {}).map((token) => lower(token))
    )
    const missing = [...new Set(requiredTokens)].filter(
        (token) => !settings.has(lower(token))
    )

    if (missing.length > 0) {
        throw new Error(
            `No simulator configured. ${action} requires explicit max slippage for each token that may be traded. Missing: ${missing.join(', ')}`
        )
    }
}

async function validateDegradedMode(
    provider: Provider,
    args: QuoteCommandArgs
): Promise<void> {
    if (args.action === 'trade') {
        if (args.maxSlippage == null) {
            throw new Error(
                'No simulator configured. trade requires --max-slippage-bps in degraded mode.'
            )
        }
        return
    }

    const assets = await getLedgerAssets(provider, args.fund)
    const addresses = getGuruProtocolAddresses(args.chainId)

    if (args.action === 'deposit' || args.action === 'withdrawal') {
        ensureSlippageCoverage(
            args.action,
            args.slippageSettings,
            assets.filter((asset) => asset !== lower(args.coin))
        )
        return
    }

    if (args.action === 'harvest' || args.action === 'close') {
        ensureSlippageCoverage(
            args.action,
            args.slippageSettings,
            assets.filter((asset) => asset !== lower(args.coin))
        )
        return
    }

    const targetTokens = args.targetWeights.map((target) => lower(target.token))
    const required = new Set(
        [...assets, ...targetTokens].filter(
            (token) => token !== lower(addresses.tokens.USDC)
        )
    )
    ensureSlippageCoverage(args.action, args.slippageSettings, required)
}

function buildQuoteMeta(
    simulationProvider: string,
    degraded: boolean
): Record<string, unknown> {
    return {
        degraded,
        simulationProvider,
    }
}

function getSimulationProviderLabel(
    configured: string,
    routeProviders: Set<'alchemy' | 'tenderly'>,
    txProviders: Set<'alchemy' | 'tenderly'>
): string {
    const used = new Set([...routeProviders, ...txProviders])
    return used.size > 0 ? summarizeProviders(used) : configured
}

export async function runQuoteCommand(
    args: QuoteCommandArgs
): Promise<QuoteCommandResponse> {
    const placeholderProtocol = new GuruProtocol({
        rpcUrl: args.rpcUrl,
        chainId: args.chainId,
    })
    const toolkit = createSimulationToolkit(
        args.chainId,
        placeholderProtocol.provider
    )
    const degraded = !toolkit.canSimulate

    if (degraded) {
        await validateDegradedMode(placeholderProtocol.provider, args)
        console.error(
            '[guru] No simulator configured. Proceeding in degraded mode with caller-provided max slippage settings.'
        )
    }

    const protocol = new GuruProtocol({
        rpcUrl: args.rpcUrl,
        chainId: args.chainId,
        simulator: toolkit.simulator,
    })

    if (args.action === 'deposit') {
        const result = await protocol.quoteDeposit({
            ledger: args.fund,
            account: args.account,
            coin: args.coin,
            amount: args.amount,
            referrerFeeBps: args.referrerFeeBps,
            slippageSettings: args.slippageSettings,
        })
        const decoded = degraded
            ? null
            : await toolkit.simulateQuoteTransaction(
                  result.txData,
                  result.decodeLogs,
                  buildDepositApprovalPrelude(
                      args.account,
                      args.coin,
                      String(result.txData.to ?? ''),
                      args.amount
                  )
              )

        return {
            quote: serializeJson({
                sharesOutMin: result.sharesOutMin,
                fees: result.fees,
                referrerFeeBps: result.referrerFeeBps,
                cumulativeSlippageBps: result.cumulativeSlippageBps,
                perAssetSlippageBps: result.perAssetSlippageBps,
                expectedShares: decoded?.expectedShares ?? result.sharesOutMin,
                ...buildQuoteMeta(
                    getSimulationProviderLabel(
                        toolkit.describeConfiguredProviders(),
                        toolkit.stats.routeProviders,
                        toolkit.stats.txProviders
                    ),
                    degraded
                ),
            }) as Record<string, unknown>,
            tx: serializeJson(
                toPrivyRpcBody(result.txData, args.chainId)
            ) as Record<string, unknown>,
            encoding: serializeJson(
                buildEncoding({
                    txData: result.txData,
                    functionName: 'deposit',
                    abi: [
                        'function deposit((address ledger,address coin,uint256 amount,(address adapter,bytes callData)[] extCalls,uint256 sharesOutMin,uint16 referrerFeeBps))',
                    ],
                    args: [
                        {
                            ledger: args.fund,
                            coin: args.coin,
                            amount: args.amount,
                            extCalls: normalizeExtCalls(result.extCalls),
                            sharesOutMin: result.sharesOutMin,
                            referrerFeeBps: result.referrerFeeBps,
                        },
                    ],
                })
            ) as Record<string, unknown>,
        }
    }

    if (args.action === 'withdrawal') {
        const result = await protocol.quoteWithdrawal({
            ledger: args.fund,
            account: args.account,
            shares: args.shares,
            coin: args.coin,
            referrerFeeBps: args.referrerFeeBps,
            slippageSettings: args.slippageSettings,
        })
        const decoded = degraded
            ? null
            : await toolkit.simulateQuoteTransaction(
                  result.txData,
                  result.decodeLogs
              )

        return {
            quote: serializeJson({
                proceeds: result.proceeds,
                referrerFeeBps: result.referrerFeeBps,
                cumulativeSlippageBps: result.cumulativeSlippageBps,
                perAssetSlippageBps: result.perAssetSlippageBps,
                netAmountOut: decoded?.netAmountOut ?? result.proceeds,
                managerFeeAmount: decoded?.managerFee ?? 0n,
                ...buildQuoteMeta(
                    getSimulationProviderLabel(
                        toolkit.describeConfiguredProviders(),
                        toolkit.stats.routeProviders,
                        toolkit.stats.txProviders
                    ),
                    degraded
                ),
            }) as Record<string, unknown>,
            tx: serializeJson(
                toPrivyRpcBody(result.txData, args.chainId)
            ) as Record<string, unknown>,
            encoding: serializeJson(
                buildEncoding({
                    txData: result.txData,
                    functionName: 'withdraw',
                    abi: [
                        'function withdraw((address ledger,address coin,uint256 shares,(address adapter,bytes callData)[] extCalls,uint16 referrerFeeBps))',
                    ],
                    args: [
                        {
                            ledger: args.fund,
                            coin: args.coin,
                            shares: args.shares,
                            extCalls: normalizeExtCalls(result.extCalls),
                            referrerFeeBps: result.referrerFeeBps,
                        },
                    ],
                })
            ) as Record<string, unknown>,
        }
    }

    if (args.action === 'harvest') {
        const result = await protocol.quoteHarvest({
            ledger: args.fund,
            coin: args.coin,
            slippageSettings: args.slippageSettings,
        })
        const decoded = degraded
            ? null
            : await toolkit.simulateQuoteTransaction(
                  result.txData,
                  result.decodeLogs
              )

        return {
            quote: serializeJson({
                harvestableFraction: result.harvestableFraction,
                managementFee: result.managementFee,
                harvestableAmount: decoded?.harvestableAmount ?? 0n,
                ...buildQuoteMeta(
                    getSimulationProviderLabel(
                        toolkit.describeConfiguredProviders(),
                        toolkit.stats.routeProviders,
                        toolkit.stats.txProviders
                    ),
                    degraded
                ),
            }) as Record<string, unknown>,
            tx: serializeJson(
                toPrivyRpcBody(result.txData, args.chainId)
            ) as Record<string, unknown>,
            encoding: serializeJson(
                buildEncoding({
                    txData: result.txData,
                    functionName: 'harvest',
                    abi: [
                        'function harvest((address ledger,address coin,uint64 fraction,bool isManagementFeeEligible,(address adapter,bytes callData)[] extCalls))',
                    ],
                    args: [
                        {
                            ledger: args.fund,
                            coin: args.coin,
                            fraction: result.harvestableFraction,
                            isManagementFeeEligible:
                                getEncodedHarvestManagementFeeEligibility(
                                    result.txData.data
                                ),
                            extCalls: normalizeExtCalls(result.extCalls),
                        },
                    ],
                })
            ) as Record<string, unknown>,
        }
    }

    if (args.action === 'close') {
        const result = await protocol.quoteClose({
            ledger: args.fund,
            coin: args.coin,
            slippageSettings: args.slippageSettings,
        })

        return {
            quote: serializeJson({
                ...buildQuoteMeta(
                    getSimulationProviderLabel(
                        toolkit.describeConfiguredProviders(),
                        toolkit.stats.routeProviders,
                        toolkit.stats.txProviders
                    ),
                    degraded
                ),
            }) as Record<string, unknown>,
            tx: serializeJson(
                toPrivyRpcBody(result.txData, args.chainId)
            ) as Record<string, unknown>,
            encoding: serializeJson(
                buildEncoding({
                    txData: result.txData,
                    functionName: 'closeFund',
                    abi: [
                        'function closeFund((address ledger,address coin,(address adapter,bytes callData)[] extCalls))',
                    ],
                    args: [
                        {
                            ledger: args.fund,
                            coin: args.coin,
                            extCalls: normalizeExtCalls(result.extCalls),
                        },
                    ],
                })
            ) as Record<string, unknown>,
        }
    }

    if (args.action === 'trade') {
        const result = await protocol.quoteTrade({
            ledger: args.fund,
            tokenIn: args.tokenIn,
            tokenOut: args.tokenOut,
            amountIn: args.amountIn,
            maxSlippage: args.maxSlippage,
        })

        return {
            quote: serializeJson({
                data: result.data,
                toll: result.toll,
                hops: result.hops,
                effectiveSlippageBps: result.effectiveSlippageBps,
                adapter: result.adapter,
                ...buildQuoteMeta(
                    getSimulationProviderLabel(
                        toolkit.describeConfiguredProviders(),
                        toolkit.stats.routeProviders,
                        toolkit.stats.txProviders
                    ),
                    degraded
                ),
            }) as Record<string, unknown>,
            tx: serializeJson(
                toPrivyRpcBody(result.txData, args.chainId)
            ) as Record<string, unknown>,
            encoding: serializeJson(
                buildEncoding({
                    txData: result.txData,
                    functionName: 'executeTrade',
                    abi: [
                        'function executeTrade(address ledger,address adapter,bytes callData)',
                    ],
                    args: [args.fund, result.adapter, result.callData],
                })
            ) as Record<string, unknown>,
        }
    }

    const result = await protocol.quoteRebalance({
        ledger: args.fund,
        targetWeights: args.targetWeights,
        slippageSettings: args.slippageSettings,
    })
    const decoded = degraded
        ? null
        : await toolkit.simulateQuoteTransaction(
              result.txData,
              result.decodeLogs
          )

    return {
        quote: serializeJson({
            trades: result.trades,
            cumulativeSlippageBps: result.cumulativeSlippageBps,
            emptyReason: result.emptyReason,
            executedTrades: decoded?.trades ?? null,
            ...buildQuoteMeta(
                getSimulationProviderLabel(
                    toolkit.describeConfiguredProviders(),
                    toolkit.stats.routeProviders,
                    toolkit.stats.txProviders
                ),
                degraded
            ),
        }) as Record<string, unknown>,
        tx: serializeJson(
            toPrivyRpcBody(result.txData, args.chainId)
        ) as Record<string, unknown>,
        encoding: serializeJson(
            buildEncoding({
                txData: result.txData,
                functionName: 'executeTrades',
                abi: [
                    'function executeTrades(address ledger,address[] adapters,bytes[] callData)',
                ],
                args: [
                    args.fund,
                    normalizeExtCalls(result.extCalls).map(
                        (call) => call.adapter
                    ),
                    normalizeExtCalls(result.extCalls).map(
                        (call) => call.callData
                    ),
                ],
            })
        ) as Record<string, unknown>,
    }
}
