import { UniswapXOrderEntity } from '../../../entities'
import { GetDutchV2OrderResponse} from './GetDutchV2OrderResponse'
import { GetRelayOrderResponse } from './GetRelayOrderResponse'

export type GetOrdersResponse<
  T extends UniswapXOrderEntity | GetRelayOrderResponse | GetDutchV2OrderResponse | undefined
> = {
  orders: T[]
  cursor?: string
}
