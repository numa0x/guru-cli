import { getAddress, toBeHex, type TransactionRequest } from 'ethers'

type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue }

const isHexString = (value: string) => /^0x[0-9a-fA-F]+$/.test(value)

function serializeBigNumberish(
    value: string | number | bigint | null | undefined
): string | undefined {
    if (value == null) return undefined
    if (typeof value === 'string') {
        return isHexString(value) ? value : toBeHex(BigInt(value))
    }
    if (typeof value === 'number') {
        return toBeHex(BigInt(value))
    }
    return toBeHex(value)
}

export function serializeJson(value: unknown): JsonValue {
    if (typeof value === 'bigint') return value.toString()
    if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
    ) {
        return value
    }
    if (Array.isArray(value)) {
        return value.map((entry) => serializeJson(entry))
    }
    if (typeof value === 'object' && value) {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
                key,
                serializeJson(entry),
            ])
        )
    }
    return String(value)
}

export function toPrivyRpcBody(
    tx: TransactionRequest,
    chainId: number
): { method: 'eth_sendTransaction'; params: Record<string, string> } {
    const params = {
        chainId: toBeHex(BigInt(chainId)),
        from:
            typeof tx.from === 'string'
                ? getAddress(tx.from)
                : tx.from != null
                  ? String(tx.from)
                  : undefined,
        to:
            typeof tx.to === 'string'
                ? getAddress(tx.to)
                : tx.to != null
                  ? String(tx.to)
                  : undefined,
        data: typeof tx.data === 'string' ? tx.data : undefined,
        value: serializeBigNumberish(
            tx.value as string | number | bigint | null | undefined
        ),
        gas: serializeBigNumberish(
            tx.gasLimit as string | number | bigint | null | undefined
        ),
        gasPrice: serializeBigNumberish(
            tx.gasPrice as string | number | bigint | null | undefined
        ),
        maxFeePerGas: serializeBigNumberish(
            tx.maxFeePerGas as string | number | bigint | null | undefined
        ),
        maxPriorityFeePerGas: serializeBigNumberish(
            tx.maxPriorityFeePerGas as
                | string
                | number
                | bigint
                | null
                | undefined
        ),
        nonce: serializeBigNumberish(
            tx.nonce as string | number | bigint | null | undefined
        ),
    }

    return {
        method: 'eth_sendTransaction',
        params: Object.fromEntries(
            Object.entries(params).filter(([, value]) => value != null)
        ) as Record<string, string>,
    }
}
