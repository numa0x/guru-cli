import { Interface } from 'ethers'

export const ERC20_INTERFACE = new Interface([
    'function transfer(address to, uint256 amount)',
    'function approve(address spender, uint256 amount)',
])

export const LEDGER_INTERFACE = new Interface([
    'function getAssets() view returns (address[])',
])
