import { BigNumber } from "ethers"

export const ANVIL_TEST_WALLET_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'

export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
export const UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'
export const WETH_GOERLI = '0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6'
export const UNI_GOERLI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'

export const MAX_UINT96 = BigNumber.from('79228162514264337593543950335')

export const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f' // DAI
export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'


export enum ChainId {
  MAINNET = 1,
  OPTIMISM = 10,
  ARBITRUM_ONE = 42161,
  POLYGON = 137,
  SEPOLIA = 11155111,
  GÖRLI = 5,
}

