#!/usr/bin/env node

import { parseArgs } from 'node:util'

import type { QuoteRebalanceTargetWeight } from '@guru-fund/sdk'
import { UnsupportedChainError } from '@guru-fund/sdk'

import { type QuoteCommandArgs, runQuoteCommand } from './quote'
import { loadQuote, saveQuote } from './quoteStore'

type OptionValues = {
    'chain-id'?: string
    'rpc-url'?: string
    fund?: string
    ledger?: string
    account?: string
    coin?: string
    amount?: string
    shares?: string
    'token-in'?: string
    'token-out'?: string
    'amount-in'?: string
    'max-slippage-bps'?: string
    'max-slippage'?: string
    'referrer-fee-bps'?: string
    'slippage-settings-bps-json'?: string
    'slippage-settings-json'?: string
    'target-weights-bps-json'?: string
    'target-weights-json'?: string
    detail?: boolean
}

type StringOptionKey = Exclude<keyof OptionValues, 'detail'>
const BPS_TO_SDK_SCALE = 10n

function usage(): string {
    return [
        'Usage:',
        '  guru quote deposit --chain-id <id> --rpc-url <url> --fund <addr> --account <addr> --coin <addr> --amount <int> [--referrer-fee-bps <bps>] [--slippage-settings-bps-json <json>]',
        '  guru quote withdrawal --chain-id <id> --rpc-url <url> --fund <addr> --account <addr> --coin <addr> --shares <int> [--referrer-fee-bps <bps>] [--slippage-settings-bps-json <json>]',
        '  guru quote harvest --chain-id <id> --rpc-url <url> --fund <addr> --coin <addr> [--slippage-settings-bps-json <json>]',
        '  guru quote close --chain-id <id> --rpc-url <url> --fund <addr> --coin <addr> [--slippage-settings-bps-json <json>]',
        '  guru quote trade --chain-id <id> --rpc-url <url> --fund <addr> --token-in <addr> --token-out <addr> --amount-in <int> [--max-slippage-bps <bps>]',
        '  guru quote rebalance --chain-id <id> --rpc-url <url> --fund <addr> --target-weights-bps-json <json> [--slippage-settings-bps-json <json>]',
        '  guru quote tx <id> [--detail]',
    ].join('\n')
}

function requireString(values: OptionValues, key: StringOptionKey): string {
    const value = values[key]
    if (!value) {
        throw new Error(`Missing required option --${key}`)
    }
    return value
}

function parseBigint(
    values: OptionValues,
    key: StringOptionKey,
    fallback?: bigint
): bigint {
    const value = values[key]
    if (!value) {
        if (fallback != null) return fallback
        throw new Error(`Missing required option --${key}`)
    }
    return BigInt(value)
}

function parseChainId(values: OptionValues): number {
    const chainId = Number(requireString(values, 'chain-id'))
    if (!Number.isInteger(chainId)) {
        throw new Error('--chain-id must be an integer')
    }
    return chainId
}

function requireFund(values: OptionValues): string {
    if (values.fund) return values.fund
    if (values.ledger) {
        process.stderr.write(
            '[guru] --ledger is deprecated. Use --fund for the Guru fund ledger address.\n'
        )
        return values.ledger
    }
    throw new Error('Missing required option --fund')
}

function rejectLegacyUnitFlags(values: OptionValues): void {
    if (values['max-slippage']) {
        throw new Error('Use --max-slippage-bps. CLI slippage input is bps.')
    }
    if (values['slippage-settings-json']) {
        throw new Error(
            'Use --slippage-settings-bps-json. CLI slippage input is bps.'
        )
    }
    if (values['target-weights-json']) {
        throw new Error(
            'Use --target-weights-bps-json. CLI weight input is bps.'
        )
    }
}

function toBigIntInput(value: string | number, label: string): bigint {
    try {
        return BigInt(value)
    } catch {
        throw new Error(`${label} must be an integer bps value`)
    }
}

function bpsToSdkScale(value: string | number | undefined, label: string): bigint {
    if (value == null || value === '') {
        throw new Error(`${label} is required`)
    }
    return toBigIntInput(value, label) * BPS_TO_SDK_SCALE
}

function parseSlippageSettingsBps(
    raw?: string
): Record<string, bigint> | undefined {
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Record<string, string | number>
    return Object.fromEntries(
        Object.entries(parsed).map(([token, slippage]) => [
            token.toLowerCase(),
            bpsToSdkScale(slippage, `slippage for ${token}`),
        ])
    )
}

function parseTargetWeightsBps(raw: string): QuoteRebalanceTargetWeight[] {
    const parsed = JSON.parse(raw) as Array<{
        token: string
        weightBps?: string | number
        weight?: string | number
    }>
    return parsed.map((entry) => ({
        token: entry.token,
        weight: bpsToSdkScale(
            entry.weightBps ?? entry.weight,
            `weightBps for ${entry.token}`
        ),
    }))
}

function parseQuoteArgs(
    action: string,
    values: OptionValues
): QuoteCommandArgs {
    rejectLegacyUnitFlags(values)

    const shared = {
        chainId: parseChainId(values),
        rpcUrl: requireString(values, 'rpc-url'),
        fund: requireFund(values),
    }

    if (action === 'deposit') {
        return {
            action: 'deposit',
            ...shared,
            account: requireString(values, 'account'),
            coin: requireString(values, 'coin'),
            amount: parseBigint(values, 'amount'),
            referrerFeeBps: parseBigint(values, 'referrer-fee-bps', 0n),
            slippageSettings: parseSlippageSettingsBps(
                values['slippage-settings-bps-json']
            ),
        }
    }

    if (action === 'withdrawal') {
        return {
            action: 'withdrawal',
            ...shared,
            account: requireString(values, 'account'),
            coin: requireString(values, 'coin'),
            shares: parseBigint(values, 'shares'),
            referrerFeeBps: parseBigint(values, 'referrer-fee-bps', 0n),
            slippageSettings: parseSlippageSettingsBps(
                values['slippage-settings-bps-json']
            ),
        }
    }

    if (action === 'harvest') {
        return {
            action: 'harvest',
            ...shared,
            coin: requireString(values, 'coin'),
            slippageSettings: parseSlippageSettingsBps(
                values['slippage-settings-bps-json']
            ),
        }
    }

    if (action === 'trade') {
        return {
            action: 'trade',
            ...shared,
            tokenIn: requireString(values, 'token-in'),
            tokenOut: requireString(values, 'token-out'),
            amountIn: parseBigint(values, 'amount-in'),
            maxSlippage: values['max-slippage-bps']
                ? bpsToSdkScale(
                      values['max-slippage-bps'],
                      '--max-slippage-bps'
                  )
                : undefined,
        }
    }

    if (action === 'close') {
        return {
            action: 'close',
            ...shared,
            coin: requireString(values, 'coin'),
            slippageSettings: parseSlippageSettingsBps(
                values['slippage-settings-bps-json']
            ),
        }
    }

    if (action === 'rebalance') {
        return {
            action: 'rebalance',
            ...shared,
            targetWeights: parseTargetWeightsBps(
                requireString(values, 'target-weights-bps-json')
            ),
            slippageSettings: parseSlippageSettingsBps(
                values['slippage-settings-bps-json']
            ),
        }
    }

    throw new Error(
        `Unsupported action "${action}". Supported actions: deposit, withdrawal, harvest, close, trade, rebalance.`
    )
}

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            'chain-id': { type: 'string' },
            'rpc-url': { type: 'string' },
            fund: { type: 'string' },
            ledger: { type: 'string' },
            account: { type: 'string' },
            coin: { type: 'string' },
            amount: { type: 'string' },
            shares: { type: 'string' },
            'token-in': { type: 'string' },
            'token-out': { type: 'string' },
            'amount-in': { type: 'string' },
            'max-slippage-bps': { type: 'string' },
            'max-slippage': { type: 'string' },
            'referrer-fee-bps': { type: 'string' },
            'slippage-settings-bps-json': { type: 'string' },
            'slippage-settings-json': { type: 'string' },
            'target-weights-bps-json': { type: 'string' },
            'target-weights-json': { type: 'string' },
            detail: { type: 'boolean' },
        },
    })

    const [command, action, id] = positionals
    if (command !== 'quote' || !action) {
        throw new Error(usage())
    }

    if (action === 'tx') {
        if (!id) {
            throw new Error('Missing required quote id')
        }
        const stored = await loadQuote(id)
        const detailedOutput = Boolean(values.detail)
        const output = detailedOutput ? stored : stored.tx
        process.stdout.write(
            `${JSON.stringify(output, null, detailedOutput ? 2 : undefined)}\n`
        )
        return
    }

    const output = await runQuoteCommand(
        parseQuoteArgs(action, values as OptionValues)
    )
    const stored = await saveQuote(output)
    process.stdout.write(`${JSON.stringify(stored, null, 2)}\n`)
}

main().catch((error) => {
    const message =
        error instanceof UnsupportedChainError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
})
