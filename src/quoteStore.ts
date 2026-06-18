import { randomBytes } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

type JsonObject = Record<string, unknown>
const QUOTE_TTL_MS = 120_000
const QUOTE_TTL_LABEL = '2 minutes'
const QUOTE_ID_LENGTH = 6
const QUOTE_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export type StoredQuote = {
    id: string
    createdAt: string
    quote: JsonObject
    encoding: JsonObject
    tx: JsonObject
}

function quoteStoreDir(): string {
    if (process.env.GURU_QUOTE_STORE_DIR) {
        return process.env.GURU_QUOTE_STORE_DIR
    }

    const stateHome =
        process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
    return join(stateHome, 'guru', 'quotes')
}

function assertQuoteId(id: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        throw new Error(`Invalid quote id "${id}"`)
    }
}

function quotePath(id: string): string {
    assertQuoteId(id)
    return join(quoteStoreDir(), `${id}.json`)
}

function generateQuoteId(): string {
    const bytes = randomBytes(QUOTE_ID_LENGTH)
    return [...bytes]
        .map((byte) => QUOTE_ID_ALPHABET[byte % QUOTE_ID_ALPHABET.length])
        .join('')
}

function isNodeError(error: unknown, code: string): boolean {
    return (
        error != null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === code
    )
}

function isExpired(createdAt: string): boolean {
    const createdAtMs = Date.parse(createdAt)
    return (
        !Number.isFinite(createdAtMs) ||
        Date.now() - createdAtMs >= QUOTE_TTL_MS
    )
}

export async function saveQuote(
    output: Pick<StoredQuote, 'quote' | 'encoding' | 'tx'>
): Promise<StoredQuote> {
    await mkdir(quoteStoreDir(), { recursive: true })

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const stored: StoredQuote = {
            id: generateQuoteId(),
            createdAt: new Date().toISOString(),
            ...output,
        }

        try {
            await writeFile(
                quotePath(stored.id),
                `${JSON.stringify(stored, null, 2)}\n`,
                { flag: 'wx' }
            )
            return stored
        } catch (error) {
            if (isNodeError(error, 'EEXIST')) continue
            throw error
        }
    }

    throw new Error('Unable to allocate a unique quote id')
}

export async function loadQuote(id: string): Promise<StoredQuote> {
    const path = quotePath(id)
    try {
        const raw = await readFile(path, 'utf8')
        const stored = JSON.parse(raw) as StoredQuote
        if (isExpired(stored.createdAt)) {
            await unlink(path).catch((error) => {
                if (!isNodeError(error, 'ENOENT')) throw error
            })
            throw new Error(
                `Quote tx id "${id}" expired. Generate a new quote and submit it within ${QUOTE_TTL_LABEL}.`
            )
        }
        return stored
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            throw new Error(
                `Quote tx id "${id}" does not exist, or it was already removed after expiring.`
            )
        }
        throw error
    }
}
