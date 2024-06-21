import { OrderType } from '@uniswap/uniswapx-sdk'
import { ORDER_STATUS } from '../../../entities'

export type GetDutchV2OrderResponse = {
  type: OrderType.Dutch_V2
  orderStatus: ORDER_STATUS
  signature: string
  encodedOrder: string

  orderHash: string
  chainId: number
  swapper: string
  reactor: string

  txHash: string | undefined
  deadline: number
  input: {
    token: string
    startAmount: string
    endAmount: string
  }
  outputs: {
    token: string
    startAmount: string
    endAmount: string
    recipient: string
  }[]
  cosignerData: {
    decayStartTime: number
    decayEndTime: number
    exclusiveFiller: string
    inputOverride: string
    outputOverrides: string[]
  }
  cosignature: string
  nonce: string
  quoteId: string | undefined
  requestId: string | undefined
}
