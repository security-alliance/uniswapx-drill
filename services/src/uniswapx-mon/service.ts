import {
  BaseServiceV2,
  StandardOptions,
  Gauge,
  Counter,
  validators,
} from '@eth-optimism/common-ts'
import { Provider } from '@ethersproject/abstract-provider'
import axios from 'axios'
import {
  DutchOrder,
  DutchInput,
  SignedUniswapXOrder,
  REACTOR_ADDRESS_MAPPING,
  DutchOutput,
} from '@uniswap/uniswapx-sdk'
import {
  ORDER_STATUS,
  OrderOutput,
  UniswapXOrderEntity,
} from '../../lib/entities'
import { GetOrdersResponse } from '../../lib/handlers/get-orders/schema/GetOrdersResponse'

import { version } from '../../package.json'
import { ChainId } from '../../lib/constants'
import { BigNumber } from 'ethers'

type Options = {
  rpc: Provider
  uniswapXServiceUrl: string
  startTimestamp: number
  testChainId: ChainId
}

type Metrics = {
  unexpectedApiErrors: Counter
  isDetectingViolations: Gauge
  orders: Gauge
}

type State = {
  lastTimestamp: number
  openOrders: Set<string>
  violationDetected: boolean
}

export class UniswapXMon extends BaseServiceV2<Options, Metrics, State> {
  constructor(options?: Partial<Options & StandardOptions>) {
    super({
      version,
      name: 'uniswapx-mon',
      loop: true,
      options: {
        loopIntervalMs: 5_000,
        ...options,
      },
      optionsSpec: {
        rpc: {
          validator: validators.provider,
          desc: 'Provider for network',
        },
        startTimestamp: {
          validator: validators.num,
          default: -1,
          desc: 'The timestamp to start from',
          public: true,
        },
        uniswapXServiceUrl: {
          validator: validators.str,
          default:
            'https://eozojk18d0.execute-api.us-east-1.amazonaws.com/prod/',
          desc: 'UniswapX service URL',
        },
        testChainId: {
          validator: validators.num,
          default: ChainId.MAINNET,
          desc: 'Chain ID to use for testing',
        },
      },
      metricsSpec: {
        unexpectedApiErrors: {
          type: Counter,
          desc: 'Number of unexpected API errors',
          labels: ['section', 'name'],
        },
        isDetectingViolations: {
          type: Gauge,
          desc: '0 if state is ok. 1 or more if there are violations.',
          labels: ['reactor', 'violation', 'chainId'],
        },
        orders: {
          type: Gauge,
          desc: 'Number of orders',
          labels: ['swapper', 'status'],
        },
      },
    })
  }

  protected async init(): Promise<void> {
    this.state.lastTimestamp = this.options.startTimestamp

    // Default state is that violations have not been detected.
    this.state.violationDetected = false
    this.state.openOrders = new Set()
  }

  private async getOrders(): Promise<UniswapXOrderEntity[]> {
    this.logger.info(`Getting orders since ${this.state.lastTimestamp}`)
    let url = `${this.options.uniswapXServiceUrl}dutch-auction/orders?chainId=${this.options.testChainId}`
    if (this.state.lastTimestamp > 0) {
      url += `&sortKey=createdAt&sort=${encodeURIComponent(
        `gt(${this.state.lastTimestamp})`
      )}`
    }
    try {
      const orders = await axios.get<GetOrdersResponse<UniswapXOrderEntity>>(
        url
      )
      const orderEntities = orders.data.orders
      this.logger.info(`Got ${orderEntities.length} orders`)
      return orderEntities
    } catch (err) {
      this.logger.info(`got unexpected API error`, {
        section: 'orders',
        name: 'getOrders',
        err,
      })
      this.metrics.unexpectedApiErrors.inc({
        section: 'orders',
        name: 'getOrders',
      })
      return []
    }
  }

  private async getOrder(
    orderHash: string
  ): Promise<UniswapXOrderEntity | null> {
    const orders = await axios.get<GetOrdersResponse<UniswapXOrderEntity>>(
      `${this.options.uniswapXServiceUrl}dutch-auction/orders?orderHash=${orderHash}`
    )
    if (orders.data.orders.length === 0) {
      this.logger.error(`Order ${orderHash} not found`)
      return null
    }
    this.logger.info(
      `Order ${orderHash} status: ${orders.data.orders[0].orderStatus}`
    )
    return orders.data.orders[0]
  }

  private async processOrder(order: UniswapXOrderEntity): Promise<void> {
    const dutchOrder = DutchOrder.parse(order.encodedOrder, order.chainId)
    const expectedInput: DutchInput = dutchOrder.info.input
    const expectedOutput: Map<
      string,
      { startAmount: BigNumber; endAmount: BigNumber }
    > = new Map()

    order.outputs.forEach((output: OrderOutput) => {
      if (!expectedOutput.has(output.token)) {
        expectedOutput.set(output.token, {
          startAmount: BigNumber.from(0),
          endAmount: BigNumber.from(0),
        })
      }
      expectedOutput.set(output.token, {
        startAmount: expectedOutput
          .get(output.token)
          .startAmount.add(output.startAmount),
        endAmount: expectedOutput
          .get(output.token)
          .endAmount.add(output.endAmount),
      })
    })

    const reactorAddress = order.reactor

    // Track open order hashes so we can get the future status
    if (order.orderStatus === ORDER_STATUS.OPEN) {
      if (!this.state.openOrders.has(order.orderHash)) {
        this.state.openOrders.add(order.orderHash)
      }
      return
    }

    // If the order is not open, remove it from the open orders set
    if (this.state.openOrders.has(order.orderHash)) {
      this.state.openOrders.delete(order.orderHash)
    }

    // If the order is filled, check the settled amounts
    if (order.orderStatus === ORDER_STATUS.FILLED) {
      const settledOutput: Map<string, BigNumber> = new Map()
      order.settledAmounts.forEach((settledAmount) => {
        const token = settledAmount.tokenOut
        const settledAmountOut = BigNumber.from(settledAmount.amountOut)
        const settledAmountIn = BigNumber.from(settledAmount.amountIn)

        // Validate input is between start and end amount
        if (settledAmountIn.lt(expectedInput.startAmount)) {
          this.logger.error(`Input amount less than start amount`, {
            settledAmountIn: settledAmountIn.toString(),
            expectedInputStartAmount: expectedInput.startAmount.toString(),
          })
          this.state.violationDetected = true
          this.metrics.isDetectingViolations.set(
            {
              reactor: reactorAddress,
              violation: 'INPUT_LT_START',
              chainId: this.options.testChainId,
            },
            1
          )
        } else if (settledAmountIn.gt(expectedInput.endAmount)) {
          this.logger.error(`Input amount greater than end amount`, {
            settledAmountIn: settledAmountIn.toString(),
            expectedInputEndAmount: expectedInput.endAmount.toString(),
          })
          this.state.violationDetected = true
          this.metrics.isDetectingViolations.set(
            {
              reactor: reactorAddress,
              violation: 'INPUT_GT_END',
              chainId: this.options.testChainId,
            },
            1
          )
        } else {
          this.logger.info(
            `Valid settled input amount for order ${order.orderHash}`,
            {
              settledAmountIn,
            }
          )
        }

        if (!settledOutput.has(token)) {
          settledOutput.set(token, BigNumber.from(0))
        }
        settledOutput.set(token, settledOutput.get(token).add(settledAmountOut))
      })

      // Validate output is between start and end amount
      settledOutput.forEach((settledAmount, token) => {
        if (settledAmount.lt(expectedOutput.get(token).endAmount)) {
          this.logger.error(`Output amount less than end amount`, {
            settledAmount: settledAmount.toString(),
            expectedMinOutput: expectedOutput.get(token).endAmount.toString(),
          })
          this.state.violationDetected = true
          this.metrics.isDetectingViolations.set(
            {
              reactor: reactorAddress,
              violation: 'OUTPUT_LT_END',
              chainId: this.options.testChainId,
            },
            1
          )
        } else if (settledAmount.gt(expectedOutput.get(token).startAmount)) {
          this.logger.error(`Output amount greater than start amount`, {
            settledAmount: settledAmount.toString(),
            expectedMaxOutput: expectedOutput.get(token).startAmount.toString(),
          })
          this.state.violationDetected = true
          this.metrics.isDetectingViolations.set(
            {
              reactor: reactorAddress,
              violation: 'OUTPUT_GT_START',
              chainId: this.options.testChainId,
            },
            1
          )
        } else {
          this.logger.info(
            `Valid settled output amount for order ${order.orderHash}`,
            {
              settledAmount,
            }
          )
        }
      })
      return
    }
  }

  private async processOrders(orders: UniswapXOrderEntity[]): Promise<void> {
    for (const order of orders) {
      this.logger.info(
        `Processing order ${order.orderHash} with status ${order.orderStatus}`
      )
      this.metrics.orders.inc(
        { swapper: order.offerer, status: order.orderStatus },
        1
      )
      await this.processOrder(order)

      // Update last timestamp
      if (order.createdAt > this.state.lastTimestamp) {
        this.state.lastTimestamp = order.createdAt
      }
    }
  }

  private async trackNewOrders(): Promise<void> {
    const orders = await this.getOrders()
    await this.processOrders(orders)
  }

  private async trackOpenOrders(): Promise<void> {
    for (const orderHash of this.state.openOrders) {
      const order = await this.getOrder(orderHash)
      if (!order) {
        this.logger.error(`Order ${orderHash} not found`)
        continue
      }
      if (order.orderStatus !== ORDER_STATUS.OPEN) {
        this.logger.info(
          `Processing existing order ${orderHash} with status ${order.orderStatus}`
        )
        this.metrics.orders.inc(
          { swapper: order.offerer, status: order.orderStatus },
          1
        )
        await this.processOrder(order)
      } else {
        this.logger.info(`Order ${orderHash} is still open`)
      }
    }
  }

  protected async main(): Promise<void> {
    console.log('Running main')
    // Get orders since last timestamp
    // For filled order
    // Get order amount & settled amount
    await this.trackOpenOrders()
    await this.trackNewOrders()
  }
}

if (require.main === module) {
  const service = new UniswapXMon()
  service.run()
}
