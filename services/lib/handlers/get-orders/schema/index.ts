import { SORT_FIELDS } from '../../../entities'
import { GetOrderTypeQueryParamEnum } from './GetOrderTypeQueryParamEnum'

export type SharedGetOrdersQueryParams = {
  limit?: number
  orderStatus?: string
  orderHash?: string
  sortKey?: SORT_FIELDS
  sort?: string
  filler?: string
  cursor?: string
  chainId?: number
  desc?: boolean
  orderType?: GetOrderTypeQueryParamEnum
}
export type RawGetOrdersQueryParams = SharedGetOrdersQueryParams & {
  swapper?: string
  orderHashes: string
  includeV2?: boolean
}
export type GetOrdersQueryParams = SharedGetOrdersQueryParams & {
  offerer?: string
  orderHashes?: string[]
}

export enum GET_QUERY_PARAMS {
  LIMIT = 'limit',
  OFFERER = 'offerer',
  ORDER_STATUS = 'orderStatus',
  ORDER_HASH = 'orderHash',
  ORDER_HASHES = 'orderHashes',
  SORT_KEY = 'sortKey',
  SORT = 'sort',
  FILLER = 'filler',
  CHAIN_ID = 'chainId',
  DESC = 'desc',
  ORDER_TYPE = 'orderType',
}
