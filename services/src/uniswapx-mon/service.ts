import {
  BaseServiceV2,
  StandardOptions,
  Gauge,
  Histogram,
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
import { ChainId, DAI, USDC } from '../../lib/constants'
import { BigNumber } from 'ethers'

// enum FilledSwapValues {
//   MIN_IN = 'min_in',
//   MAX_IN = 'max_in',
//   MIN_OUT = 'min_out',
//   MAX_OUT = 'max_out',
//   SETTLED_IN = 'settled_in',
//   SETTLED_OUT = 'settled_out',
// }

type Options = {
  rpc: Provider
  uniswapXServiceUrl: string
  startTimestamp: number
  testChainId: ChainId
  customReactorAddress: string
  defaultReactorAddress: string
}

type Metrics = {
  unexpectedApiErrors: Counter
  isDetectingViolations: Gauge
  orders: Gauge // Orders by status and reactor
  filledSwapValue: Histogram // output value / input value by reactor
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
        customReactorAddress: {
          validator: validators.str,
          default: '0x86d160ddc49b18be0001948e7d81358c74af24aa',
          desc: 'Custom reactor address',
        },
        defaultReactorAddress: {
          validator: validators.str,
          default: '0x6000da47483062a0d734ba3dc7576ce6a0b645c4',
          desc: 'Default reactor address',
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
          labels: ['status', 'reactor'],
        },
        filledSwapValue: {
          type: Histogram,
          desc: 'Filled swap value output/input by reactor',
          labels: ['reactor'],
        },
      },
    })
  }

  protected async init(): Promise<void> {
    console.log(`Starting UniswapX monitor`)
    this.state.lastTimestamp = this.options.startTimestamp

    // Default state is that violations have not been detected.
    this.state.violationDetected = false
    this.state.openOrders = new Set()

    const reactorAddresses = [
      this.options.defaultReactorAddress,
      this.options.customReactorAddress,
    ]

    // Ensure reactor addresses are valid and not undefined
    if (
      !reactorAddresses.every(
        (address) => typeof address === 'string' && address
      )
    ) {
      this.logger.error('Invalid reactor addresses', { reactorAddresses })
      throw new Error(
        'Reactor addresses are invalid or not properly configured.'
      )
    }

    reactorAddresses.forEach((reactorAddress) => {
      Object.values(ORDER_STATUS).forEach((status) => {
        this.metrics.orders.set({ status, reactor: reactorAddress }, 0)
      })
    })
    // reactorAddresses.forEach((reactorAddress) => {
    //   this.metrics.filledSwapValue.set({ reactor: reactorAddress }, 0)
    // })
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
      this.logger.info(`Got ${orderEntities.length} new orders`)
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

  private calculateTokenValue(token: string, amount: BigNumber): number {
    let value = 0

    switch (token.toLowerCase()) {
      case USDC.toLowerCase():
        value = amount.div(BigNumber.from(10).pow(6)).toNumber()
        break
      case DAI.toLowerCase():
        value = amount.div(BigNumber.from(10).pow(18)).toNumber()
        break
      default:
        this.logger.error(`Unknown token ${token}`)
    }
    return value
  }

  private async processOrder(order: UniswapXOrderEntity): Promise<void> {
    const dutchOrder = DutchOrder.parse(order.encodedOrder, order.chainId)

    const reactorAddress = dutchOrder.info.reactor

    // Track status if not open
    if (order.orderStatus !== ORDER_STATUS.OPEN) {
      this.metrics.orders.inc(
        { status: order.orderStatus, reactor: reactorAddress },
        1
      )
    }
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
      let settledAmountIn = BigNumber.from(0)
      let tokenIn: string
      order.settledAmounts.forEach((settledAmount) => {
        tokenIn = settledAmount.tokenIn
        const token = settledAmount.tokenOut
        const settledAmountOut = BigNumber.from(settledAmount.amountOut)
        settledAmountIn = BigNumber.from(settledAmount.amountIn)

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

      // Track filled swap values
      // const expectedInputMinValue = await this.calculateTokenValue(
      //   expectedInput.token,
      //   expectedInput.startAmount
      // )
      // const expectedInputMaxValue = await this.calculateTokenValue(
      //   expectedInput.token,
      //   expectedInput.endAmount
      // )

      // let expectedOutputMinValue = 0
      // let expectedOutputMaxValue = 0
      // expectedOutput.forEach((output, token) => {
      //   expectedOutputMinValue += this.calculateTokenValue(
      //     token,
      //     output.startAmount
      //   )
      //   expectedOutputMaxValue += this.calculateTokenValue(
      //     token,
      //     output.endAmount
      //   )
      // })

      const settledInputValue = this.calculateTokenValue(
        tokenIn,
        settledAmountIn
      )

      let settledOutputValue = 0
      settledOutput.forEach((settledAmount, token) => {
        settledOutputValue += this.calculateTokenValue(token, settledAmount)
      })
      this.logger.info(
        `Filled swap input and output values for order ${order.orderHash} on ${reactorAddress}`,
        {
          settledInputValue,
          settledOutputValue,
        }
      )

      if (settledInputValue > 0) {
        const swapValue = settledOutputValue / settledInputValue
        this.logger.info(
          `Filled swap value for order ${order.orderHash} on ${reactorAddress}`,
          {
            swapValue,
          }
        )
        this.metrics.filledSwapValue.observe(
          { reactor: reactorAddress },
          swapValue
        )
      } else {
        this.logger.error(`Invalid settled input value`, {
          settledInputValue,
        })
      }

      return
    }
  }

  private async processOrders(orders: UniswapXOrderEntity[]): Promise<void> {
    for (const order of orders) {
      // this.logger.info(
      //   `Processing order ${order.orderHash} with status ${order.orderStatus}`
      // )
      await this.processOrder(order)

      // Update last timestamp
      if (order.createdAt > this.state.lastTimestamp) {
        this.state.lastTimestamp = order.createdAt
      }
    }
  }

  private async trackNewOrders(): Promise<void> {
    const orders = await this.getOrders()

    // Set open orders amount
    const openOrders = orders.filter(
      (order) => order.orderStatus === ORDER_STATUS.OPEN
    )
    const defaultReactorOpenOrders = openOrders.filter(
      (order) =>
        order.reactor.toLowerCase() ===
        this.options.defaultReactorAddress.toLowerCase()
    )
    const customReactorOpenOrders = openOrders.filter(
      (order) =>
        order.reactor.toLowerCase() ===
        this.options.customReactorAddress.toLowerCase()
    )
    this.metrics.orders.set(
      { status: 'open', reactor: this.options.defaultReactorAddress },
      defaultReactorOpenOrders.length
    )
    this.metrics.orders.set(
      { status: 'open', reactor: this.options.customReactorAddress },
      customReactorOpenOrders.length
    )

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
        // this.logger.info(
        //   `Processing existing order ${orderHash} with status ${order.orderStatus}`
        // )
        await this.processOrder(order)
      }
      // else {
      //   this.logger.info(`Order ${orderHash} is still open`)
      // }
    }
  }

  protected async main(): Promise<void> {
    console.log(`Running UniswapX monitor main`)
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
