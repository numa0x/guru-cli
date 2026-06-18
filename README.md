# @guru-fund/cli

JSON-first agent CLI for Guru Protocol fund operations.

`@guru-fund/cli` quotes Guru fund actions, optionally validates route executability
with Alchemy or Tenderly, saves each quote for a short signer handoff window,
and emits transaction JSON for signers such as Privy or Turnkey.

## Recommended Stack

-   `@guru-fund/cli` for quote generation, calldata packaging, and encoding details
-   Privy Agent CLI or Turnkey for signing and broadcast
-   Alchemy or Tenderly for quote-time route simulation

The trust boundary is explicit:

-   Guru builds the quote, calldata, and equivalent `encoding` payload.
-   Privy or Turnkey signs and broadcasts the transaction request.
-   Alchemy or Tenderly validates quote-time route/calldata executability.

Guru CLI never stores keys and never signs transactions. It does generate the
encoded transaction `data`; use the returned `encoding` object if you want to
rebuild or inspect the calldata independently before signing.

## Install

Install the Guru CLI:

```sh
npm install -g @guru-fund/cli
```

For Privy handoff, also install and authenticate the Privy Agent CLI:

```sh
npm install -g @privy-io/agent-wallet-cli
privy-agent-wallets login
```

For Turnkey handoff, install Turnkey dependencies in the project that will run
your submitter script:

```sh
npm install @turnkey/sdk-server @turnkey/ethers ethers
```

## Configuration

Common flags:

-   `--chain-id` (`1` or `8453`)
-   `--rpc-url`
-   `--fund` (the Guru fund ledger address)

All CLI percentage inputs are basis points:

-   `100` = 1%
-   `600` = 6%
-   rebalance target weights are also bps and must sum to `10000`

Simulation providers:

-   `ALCHEMY_API_KEY`
-   `TENDERLY_ACCESS_TOKEN`
-   `TENDERLY_ACCOUNT_NAME`
-   `TENDERLY_PROJECT_NAME`

These are read from the process environment — the CLI does not load `.env`
files. Export them in the shell (or inject them via your process manager)
before invoking `guru`:

```sh
export ALCHEMY_API_KEY=<key>
guru quote deposit ...
```

Production use should configure at least one simulator. If both Alchemy and
Tenderly are configured, the CLI prefers Alchemy first and falls back to
Tenderly when Alchemy cannot evaluate a route or transaction bundle. The
Tenderly variables are all-or-nothing: setting only some of the three fails
at startup.

A simulation-backed quote reports which provider validated it via
`quote.simulationProvider` and `quote.degraded: false`.

Saved quote storage:

-   `GURU_QUOTE_STORE_DIR` overrides the local quote store location.
-   Quote ids are six characters.
-   Saved quotes expire after 2 minutes.
-   Saved quote files contain pending transaction metadata, including `from`,
    calldata, and encoding arguments.

## Commands

The public CLI surface is a single command family:

```sh
guru quote <action> ...
```

Supported quote actions:

-   `deposit`
-   `withdrawal`
-   `harvest`
-   `trade`
-   `rebalance`

Saved quote handoff:

-   `guru quote tx <id>`
-   `guru quote tx <id> --detail`

Usage:

```sh
guru quote deposit --chain-id <id> --rpc-url <url> --fund <addr> --account <addr> --coin <addr> --amount <int> [--referrer-fee-bps <bps>] [--slippage-settings-bps-json <json>]
guru quote withdrawal --chain-id <id> --rpc-url <url> --fund <addr> --account <addr> --coin <addr> --shares <int> [--referrer-fee-bps <bps>] [--slippage-settings-bps-json <json>]
guru quote harvest --chain-id <id> --rpc-url <url> --fund <addr> --coin <addr> [--slippage-settings-bps-json <json>]
guru quote trade --chain-id <id> --rpc-url <url> --fund <addr> --token-in <addr> --token-out <addr> --amount-in <int> [--max-slippage-bps <bps>]
guru quote rebalance --chain-id <id> --rpc-url <url> --fund <addr> --target-weights-bps-json <json> [--slippage-settings-bps-json <json>]
guru quote tx <id> [--detail]
```

## Examples

Deposit:

```sh
guru quote deposit \
  --chain-id 1 \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/KEY \
  --fund <fund-ledger-address> \
  --account <wallet-address> \
  --coin <deposit-token-address> \
  --amount 1000000
```

Withdrawal:

```sh
guru quote withdrawal \
  --chain-id 1 \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/KEY \
  --fund <fund-ledger-address> \
  --account <wallet-address> \
  --coin <withdraw-token-address> \
  --shares 1000000000000000000
```

Harvest:

```sh
guru quote harvest \
  --chain-id 1 \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/KEY \
  --fund <fund-ledger-address> \
  --coin <stablecoin-address>
```

Trade:

```sh
guru quote trade \
  --chain-id 1 \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/KEY \
  --fund <fund-ledger-address> \
  --token-in <token-in-address> \
  --token-out <token-out-address> \
  --amount-in 1000000000000000000 \
  --max-slippage-bps 100
```

Rebalance:

```sh
guru quote rebalance \
  --chain-id 1 \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/KEY \
  --fund <fund-ledger-address> \
  --target-weights-bps-json '[{"token":"<token-a-address>","weightBps":"5000"},{"token":"<token-b-address>","weightBps":"5000"}]'
```

Degraded-mode deposit with explicit per-token bounds:

```sh
guru quote deposit \
  --chain-id 1 \
  --rpc-url https://eth.llamarpc.com \
  --fund <fund-ledger-address> \
  --account <wallet-address> \
  --coin <deposit-token-address> \
  --amount 1000000 \
  --slippage-settings-bps-json '{"<token-a-address>":"600","<token-b-address>":"600"}'
```

## Output

Quote commands write JSON to stdout and save the quote locally for 2 minutes.
The top-level `id` can be used to retrieve the transaction body later.

Example deposit quote response:

```json
{
    "id": "k8m2p1",
    "createdAt": "2026-06-10T12:00:00.000Z",
    "quote": {
        "sharesOutMin": "990",
        "expectedShares": "1000",
        "fees": "2000",
        "referrerFeeBps": "0",
        "cumulativeSlippageBps": "45",
        "perAssetSlippageBps": {
            "0xTokenA": "45"
        },
        "degraded": false,
        "simulationProvider": "alchemy"
    },
    "encoding": {
        "contract": {
            "name": "FundController",
            "address": "0x..."
        },
        "from": "0x...",
        "functionName": "deposit",
        "abi": [
            "function deposit((address ledger,address coin,uint256 amount,(address adapter,bytes callData)[] extCalls,uint256 sharesOutMin,uint16 referrerFeeBps))"
        ],
        "args": [
            {
                "ledger": "0x...",
                "coin": "0x...",
                "amount": "1000000",
                "extCalls": [
                    {
                        "adapter": "0x...",
                        "callData": "0x..."
                    }
                ],
                "sharesOutMin": "990",
                "referrerFeeBps": "0"
            }
        ]
    },
    "tx": {
        "method": "eth_sendTransaction",
        "params": {
            "to": "0x...",
            "from": "0x...",
            "data": "0x...",
            "chainId": "0x1"
        }
    }
}
```

`tx.params.data` is the Guru-generated calldata. `encoding` contains the
contract, ABI fragment, function name, and exact arguments needed to rebuild
that calldata yourself. The transaction request may omit nonce and gas fields;
your signer or provider can populate those at broadcast time.

Retrieve submission-ready transaction JSON:

```sh
guru quote tx k8m2p1
```

Response:

```text
{"method":"eth_sendTransaction","params":{"to":"0x...","from":"0x...","data":"0x...","chainId":"0x1"}}
```

Retrieve the complete saved quote envelope:

```sh
guru quote tx k8m2p1 --detail
```

Expired and missing quote ids:

-   If a saved quote is older than 2 minutes, `guru quote tx <id>` deletes it
    and returns an expired-quote error.
-   If the id does not exist, the CLI reports that the quote does not exist or
    was already removed after expiring.

## Privy Handoff

Privy documents transaction submission through:

```sh
privy-agent-wallets rpc --json '{"method":"eth_sendTransaction","params":{...}}'
```

That maps directly to Guru CLI output:

```sh
guru quote deposit ...
# review id, quote.*, encoding.*, and tx.*
guru quote tx k8m2p1 | privy-agent-wallets rpc --json
```

`guru quote tx <id>` emits the full RPC body for Privy's
`eth_sendTransaction` flow. If you need a different signer flow, the saved
quote's `tx.params` contains the underlying transaction request.

## Turnkey Handoff

Turnkey does not require Guru-specific support. Read the saved transaction
body, pass `tx.params` into a Turnkey-powered signer, and broadcast through
your normal provider. Turnkey documents EVM signing through `@turnkey/ethers`
and `@turnkey/viem` in its
[Ethereum docs](https://docs.turnkey.com/features/networks/ethereum).

If you prefer to own the transaction assembly, use the saved quote's
`encoding` object to rebuild `data`, then pass the resulting request into your
Turnkey signer.

Example `submit-turnkey.mjs`:

```js
import { stdin } from 'node:process'
import { ethers } from 'ethers'
import { Turnkey } from '@turnkey/sdk-server'
import { TurnkeySigner } from '@turnkey/ethers'

const raw = await new Promise((resolve, reject) => {
    let body = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk) => {
        body += chunk
    })
    stdin.on('end', () => resolve(body))
    stdin.on('error', reject)
})

const tx = JSON.parse(raw)
if (tx.method !== 'eth_sendTransaction') {
    throw new Error(`Unsupported Guru tx method: ${tx.method}`)
}

const turnkey = new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID,
    apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
    apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
})

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL)
const signer = new TurnkeySigner({
    client: turnkey.apiClient(),
    organizationId: process.env.TURNKEY_ORGANIZATION_ID,
    signWith: process.env.TURNKEY_SIGN_WITH,
}).connect(provider)

const { from, ...request } = tx.params
const signerAddress = await signer.getAddress()
if (from && from.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(
        `Guru tx is from ${from}, but Turnkey signer is ${signerAddress}`
    )
}

const response = await signer.sendTransaction(request)
console.log(response.hash)
```

Then:

```sh
guru quote deposit ...
# review id, quote.*, encoding.*, and tx.*
guru quote tx k8m2p1 | node submit-turnkey.mjs
```

Turnkey also supports a Viem integration through `@turnkey/viem`; the same
Guru handoff applies, but feed `tx.params` into your Viem wallet client.

For autonomous agents, Turnkey's
[delegated agent signing docs](https://docs.turnkey.com/features/policies/delegated-access/agentic-wallets)
cover scoped credentials and policies.

## Degraded Mode

When no simulator is configured, Guru can still produce a quote in explicit
degraded mode if the caller supplies enough slippage intent.

Degraded mode rules:

-   `trade` requires `--max-slippage-bps`.
-   `deposit`, `withdrawal`, `harvest`, and `rebalance` require
    `--slippage-settings-bps-json`.
-   The slippage map must cover every token the action may need to trade.
-   The CLI prints a warning to stderr and marks `quote.degraded` as `true`.

Example:

```sh
guru quote trade \
  --chain-id 1 \
  --rpc-url https://eth.llamarpc.com \
  --fund <fund-ledger-address> \
  --token-in <token-in-address> \
  --token-out <token-out-address> \
  --amount-in 1000000000000000000 \
  --max-slippage-bps 100
```

## Roles

-   `deposit` and `withdrawal` are user/account actions; the transaction `from`
    is the supplied `--account`.
-   `harvest`, `trade`, and `rebalance` are manager actions; the transaction
    `from` is read from the fund ledger manager.

## Failure Modes

-   Missing or partial Tenderly configuration fails immediately.
-   Unsupported chains fail at CLI startup.
-   Legacy unit flags fail with migration hints; use the `*-bps` flags.
-   Simulation-backed quote failures are distinct from no-sim degraded mode.
-   Privy login/session problems are handled by the Privy CLI, not Guru CLI.
-   Turnkey credential, policy, and signer-address mismatches are handled by
    the Turnkey integration, not Guru CLI.
-   Expired quote ids are deleted before the CLI returns an expired-quote
    error.
-   Missing quote ids report that the quote does not exist or was already
    removed after expiring.

## Security Notes

-   Guru CLI never sees the wallet private key.
-   Guru CLI does generate transaction calldata; inspect `encoding` if the
    calldata builder is part of your trust review.
-   Privy sessions and Turnkey delegated credentials are authenticated
    separately and can be revoked by the human owner.
-   Submit saved quotes within 2 minutes; regenerate the quote if it expires or
    if market conditions or fund balances may have changed.
-   Production quoting should use Alchemy or Tenderly.
