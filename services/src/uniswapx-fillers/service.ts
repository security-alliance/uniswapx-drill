import {
  BaseServiceV2,
  StandardOptions,
  ExpressRouter,
  Gauge,
  validators,
  waitForProvider,
} from '@eth-optimism/common-ts'
import { sleep } from '@eth-optimism/core-utils'
import { Provider } from '@ethersproject/abstract-provider'
import { BigNumber, Signer, Wallet, ethers, utils } from 'ethers'
import {
  DutchOrder,
  SignedUniswapXOrder,
  REACTOR_ADDRESS_MAPPING,
  DutchOutput,
} from '@uniswap/uniswapx-sdk'
import { ORDER_STATUS, UniswapXOrderEntity } from '../../lib/entities'
import axios from 'axios'
import { factories } from '@uniswap/uniswapx-sdk/dist/src/contracts/index'
import {
  ChainId,
  DAI,
  MAX_UINT96,
  PERMIT2,
  UNI,
  USDC,
  WETH,
  ZERO_ADDRESS,
} from '../../lib/constants'

import { version } from '../../package.json'

import { Erc20TokenAbi } from '../../lib/abi/ERC20TokenAbi'
import { GetOrdersResponse } from '../../lib/handlers/get-orders/schema/GetOrdersResponse'
const { ExclusiveDutchOrderReactor__factory } = factories

type OrderExecution = {
  orders: SignedUniswapXOrder[]
  reactor: string
  fillContract: string
  fillData: string
}


type Options = {
  l1RpcProvider: Provider
  mnemonic: string
  faucetKey: string
  sleepTimeMs: number
  numBots: number
  minimumBotBalance: string
  faucetEthTxAmount: string
  faucetErc20TxAmount: string
  testChainId: ChainId
  uniswapXServiceUrl: string
  defaultDeadlineSeconds: number
}

type Metrics = {
  nodeConnectionFailures: Gauge
  faucetBalance: Gauge
  faucetErc20Balance: Gauge
  balances: Gauge
  Erc20ABalances: Gauge
}

type Bot = {
  signer: Wallet
  EthBalance: BigNumber
  Erc20ABalance: BigNumber
  Erc20BBalance: BigNumber
  address: string
  nickname: string
}

type ERC20Contract = {
  contract: ethers.Contract
  decimals: number
}

type Order = {
  order: DutchOrder
  signature: string
}

type State = {
  bots: Bot[]
  faucetSigner: Signer
  erc20TokenA: ERC20Contract
  erc20TokenB: ERC20Contract
  orders: Map<ORDER_STATUS, Map<string, Order>>
  pendingOrders: Set<string>
}

const MAX_UINT256 = BigNumber.from(2).pow(256).sub(1)

export class ERC20Bot extends BaseServiceV2<Options, Metrics, State> {
  constructor(options?: Partial<Options & StandardOptions>) {
    super({
      version,
      name: 'uniswapx-fillers',
      loop: true,
      options: {
        loopIntervalMs: 1000,
        ...options,
      },
      optionsSpec: {
        l1RpcProvider: {
          validator: validators.provider,
          desc: 'Provider for interacting with L1',
        },
        mnemonic: {
          validator: validators.str,
          desc: 'Mnemonic for the account that will be used to send transactions',
        },
        faucetKey: {
          validator: validators.str,
          desc: 'Private key for the faucet account that will be used to send transactions',
        },
        numBots: {
          validator: validators.num,
          default: 10,
          desc: 'Number of bots to run',
        },
        sleepTimeMs: {
          validator: validators.num,
          default: 15000,
          desc: 'Time in ms to sleep when waiting for a node',
          public: true,
        },
        minimumBotBalance: {
          validator: validators.str,
          default: '0.01',
          desc: 'Minimum balance of a bot',
        },
        faucetEthTxAmount: {
          validator: validators.str,
          default: '0.5',
          desc: 'Amount of ETH to request from the faucet',
        },
        faucetErc20TxAmount: {
          validator: validators.str,
          default: '100',
          desc: 'Amount of ERC20 to request from the faucet',
        },
        testChainId: {
          validator: validators.num,
          default: ChainId.MAINNET,
          desc: 'Chain ID to use for testing',
        },
        uniswapXServiceUrl: {
          validator: validators.str,
          default:
            'https://eozojk18d0.execute-api.us-east-1.amazonaws.com/prod/',
          desc: 'UniswapX service URL',
        },
        defaultDeadlineSeconds: {
          validator: validators.num,
          default: 48,
          desc: 'Default deadline in seconds',
        },
      },
      metricsSpec: {
        nodeConnectionFailures: {
          type: Gauge,
          desc: 'Number of times node connection has failed',
          labels: ['layer', 'section'],
        },
        faucetBalance: {
          type: Gauge,
          desc: 'Faucet L1 balance',
        },
        faucetErc20Balance: {
          type: Gauge,
          desc: 'Faucet ERC20 balance',
        },
        balances: {
          type: Gauge,
          desc: 'Balances of addresses',
          labels: ['address', 'nickname'],
        },
        Erc20ABalances: {
          type: Gauge,
          desc: 'Balances of addresses',
          labels: ['address', 'nickname'],
        },
      },
    })
  }

  private getRandomOtherBot(bot: Bot): Bot {
    return this.state.bots.filter((b) => b.address !== bot.address)[
      Math.floor(Math.random() * (this.state.bots.length - 1))
    ]
  }

  async init(): Promise<void> {
    // Connect to L1.
    await waitForProvider(this.options.l1RpcProvider, {
      logger: this.logger,
      name: 'L1',
    })

    this.state.faucetSigner = new Wallet(this.options.faucetKey).connect(
      this.options.l1RpcProvider
    )

    const faucetAddress = await this.state.faucetSigner.getAddress()
    console.log(`Initialized faucet signer ${faucetAddress}`)

    this.state.erc20TokenA = {
      contract: new ethers.Contract(
        DAI,
        Erc20TokenAbi,
        this.options.l1RpcProvider
      ),
      decimals: 18,
    }

    this.state.erc20TokenB = {
      contract: new ethers.Contract(
        USDC,
        Erc20TokenAbi,
        this.options.l1RpcProvider
      ),
      decimals: 6,
    }

    this.state.bots = []

    Array.from({ length: this.options.numBots }).forEach(async (_, i) => {
      const signer = Wallet.fromMnemonic(
        this.options.mnemonic,
        `m/44'/60'/0'/0/${i}`
      ).connect(this.options.l1RpcProvider)
      this.state.bots.push({
        signer: signer,
        address: signer.address,
        EthBalance: BigNumber.from(0),
        Erc20ABalance: BigNumber.from(0),
        Erc20BBalance: BigNumber.from(0),
        nickname: `Filler-${i}`,
      })
      console.log(`Added Filler signer ${signer.address}`)
    })

    this.state.orders = new Map()
    this.state.orders.set(ORDER_STATUS.OPEN, new Map())
    this.state.orders.set(ORDER_STATUS.EXPIRED, new Map())
    this.state.orders.set(ORDER_STATUS.ERROR, new Map())
    this.state.orders.set(ORDER_STATUS.CANCELLED, new Map())
    this.state.orders.set(ORDER_STATUS.FILLED, new Map())
    this.state.orders.set(ORDER_STATUS.INSUFFICIENT_FUNDS, new Map())
    this.state.pendingOrders = new Set()
  }

  // K8s healthcheck
  async routes(router: ExpressRouter): Promise<void> {
    router.get('/healthz', async (req, res) => {
      return res.status(200).json({
        ok: true,
      })
    })
  }

  private async ensureMinimumBalances(bot: Bot): Promise<void> {
    // Parse options
    const minimumBotBalance = utils.parseEther(this.options.minimumBotBalance)
    const faucetEthTxAmount = utils.parseEther(this.options.faucetEthTxAmount)
    const faucetERC20TxAmount = utils
      .parseEther(this.options.faucetErc20TxAmount)
      .div(BigNumber.from(10).pow(18 - this.state.erc20TokenB.decimals))

    if (bot.EthBalance.lt(minimumBotBalance)) {
      console.log(
        `Filler signer ${bot.address} balance: ${bot.EthBalance} < ${minimumBotBalance}`
      )
      const faucetEthTx = await this.state.faucetSigner.sendTransaction({
        to: bot.address,
        value: faucetEthTxAmount,
      })
      await faucetEthTx.wait()
    }

    if (bot.Erc20BBalance.lt(faucetERC20TxAmount)) {
      console.log(
        `Filler signer ${bot.address} ERC20 balance: ${bot.Erc20BBalance} < ${faucetERC20TxAmount}`
      )
      const faucetERC20Tx = await this.state.faucetSigner.sendTransaction(
        await this.state.erc20TokenB.contract.populateTransaction.transfer(
          bot.address,
          faucetERC20TxAmount
        )
      )
      await faucetERC20Tx.wait()
    } else {
      console.log(
        `Filler signer ${bot.address} ERC20 balance: ${bot.Erc20BBalance} >= ${faucetERC20TxAmount}`
      )
    }
  }


  private async trackOrders(): Promise<void> {
    const orders = await axios.get<GetOrdersResponse<UniswapXOrderEntity>>(
      `${this.options.uniswapXServiceUrl}dutch-auction/orders?chainId=${this.options.testChainId}&orderStatus=open`
    )
    console.log(`Tracking ${orders.data.orders.length} orders`)
    for (const order of orders.data.orders) {
      
      // Update orders map with returned status
      if (!this.state.orders.get(order.orderStatus)?.has(order.orderHash)) {
        this.state.orders.get(order.orderStatus)?.set(order.orderHash, {
          order: DutchOrder.parse(order.encodedOrder, order.chainId),
          signature: order.signature,
        })
      }
      // // If not open, remove from open orders and pending orders
      // if (order.orderStatus !== ORDER_STATUS.OPEN) {
      //   this.state.orders.get(ORDER_STATUS.OPEN)?.delete(order.orderHash)
      // }

      // if (this.state.pendingOrders.has(order.orderHash)) {
      //   this.state.pendingOrders.delete(order.orderHash)
      // }
    }
  }

  private async trackBotBalances(bot: Bot): Promise<void> {
    const ethBalance = await bot.signer.getBalance()
    this.metrics.balances.set(
      { address: bot.address, nickname: bot.nickname },
      parseInt(ethBalance.toString(), 10)
    )

    const erc20ABalance = await this.state.erc20TokenA.contract.balanceOf(
      bot.address
    )
    this.metrics.Erc20ABalances.set(
      { address: bot.address, nickname: bot.nickname },
      parseInt(erc20ABalance.toString(), 10)
    )

    const erc20BBalance = await this.state.erc20TokenB.contract.balanceOf(
      bot.address
    )
    this.metrics.Erc20ABalances.set(
      { address: bot.address, nickname: bot.nickname },
      parseInt(erc20BBalance.toString(), 10)
    )

    bot.EthBalance = ethBalance
    bot.Erc20ABalance = erc20ABalance
    bot.Erc20BBalance = erc20BBalance
  }

  private async trackFaucetBalances(): Promise<void> {
    const faucetBalance = await this.state.faucetSigner.getBalance()
    console.log(`Faucet L1 balance: ${faucetBalance}`)
    const faucetAddress = await this.state.faucetSigner.getAddress()
    const faucetERC20Balance = await this.state.erc20TokenB.contract.balanceOf(
      faucetAddress
    )
    this.metrics.faucetBalance.set(parseInt(faucetBalance.toString(), 10))
    this.metrics.faucetErc20Balance.set(
      parseInt(faucetERC20Balance.toString(), 10)
    )
    console.log(`Faucet ERC20 balance: ${faucetERC20Balance}`)
  }

  private async runErc20Transfers(bot: Bot): Promise<void> {
    const transferAmount = bot.Erc20BBalance.div(5)
    const otherBot = this.getRandomOtherBot(bot)
    console.log(
      `Transferring ${utils.formatEther(transferAmount)} ERC20 from ${
        bot.address
      } to ${otherBot.address}`
    )
    const transferTx = await bot.signer.sendTransaction(
      await this.state.erc20TokenB.contract.populateTransaction.transfer(
        otherBot.address,
        transferAmount
      )
    )
    await transferTx.wait()
    console.log(
      `Transferred ${utils.formatEther(transferAmount)} ERC20 from ${
        bot.address
      } to ${otherBot.address}`
    )
  }

  private async canFill(bot: Bot, outputs: DutchOutput[]): Promise<boolean> {
    const tokensNeeded: Map<string, BigNumber> = new Map()
    for (const output of outputs) {
      if (!tokensNeeded.has(output.token)) {
        tokensNeeded.set(output.token, BigNumber.from(0))
      }
      tokensNeeded.set(
        output.token,
        tokensNeeded.get(output.token)!.add(output.startAmount)
      )

      const outputToken = new ethers.Contract(
        output.token,
        Erc20TokenAbi,
        this.options.l1RpcProvider
      )
      const fillerBalance = await outputToken.balanceOf(bot.address)
      const requiredBalance = tokensNeeded.get(output.token)!
      console.log(
        `Required balance for ${output.token}: ${requiredBalance.toString()}`
      )
      if (fillerBalance.lt(requiredBalance)) {
        console.log(
          `Filler ${bot.address} does not have enough balance for output token ${output.token}`
        )
        return false
      }
    }
    return true
  }

  private async runOutputApprovals(
    bot: Bot,
    reactor: string,
    outputs: DutchOutput[]
  ): Promise<void> {
    for (const output of outputs) {
      const outputToken = new ethers.Contract(
        output.token,
        Erc20TokenAbi,
        this.options.l1RpcProvider
      )
      const approval = await outputToken.allowance(bot.address, reactor)
      if (approval.lt(MAX_UINT256)) {
        console.log(
          `Approving ${output.token} from ${bot.address} to ${reactor}`
        )
      }
      const approvalTx = await bot.signer.sendTransaction(
        await outputToken.populateTransaction.approve(reactor, MAX_UINT256)
      )
      await approvalTx.wait()
    }
  }

  private async runFillOrders(bot: Bot): Promise<void> {
    console.log(`Filler signer ${bot.address} filling orders`)
    const openOrders = this.state.orders.get(ORDER_STATUS.OPEN)
    const openOrderEntries: IterableIterator<[string, Order]> =
      openOrders.entries()
    console.log(`Found ${openOrders?.size} open orders`)
    for (const [orderHash, order] of openOrderEntries) {
      if (this.state.pendingOrders.has(orderHash)) {
        console.log(`Skipping pending order: ${orderHash}`)
        continue
      }
      try {
        const canFill = await this.canFill(bot, order.order.info.outputs)
        if (!canFill) {
          console.log(
            `Filler ${bot.address} does not have enough balance for order: ${orderHash}`
          )
          continue
        }
        const reactorAddress = order.order.info.reactor
        await this.runOutputApprovals(
          bot,
          reactorAddress,
          order.order.info.outputs
        )
        console.log(`Filling order: ${orderHash}`)
        this.state.pendingOrders.add(orderHash)
        const fillTxHash = await this.fillOrder(
          bot.signer,
          order.order,
          order.signature
        )
        console.log(`Filled order: ${fillTxHash}`)
        break
      } catch (e) {
        console.error(`Error filling order: ${e}`)
      }
    }
  }

  private async fillOrder(
    filler: Wallet,
    order: DutchOrder,
    signature: string
  ): Promise<string> {
    const execution: OrderExecution = {
      orders: [
        {
          order,
          signature,
        },
      ],
      reactor: REACTOR_ADDRESS_MAPPING[this.options.testChainId]['Dutch']!,
      // direct fill is 0x01
      fillContract: '0x0000000000000000000000000000000000000001',
      fillData: '0x',
    }

    // if output token is ETH, then the value is the amount of ETH to send
    const value =
      order.info.outputs[0].token == ZERO_ADDRESS
        ? order.info.outputs[0].startAmount
        : 0

    const reactor = ExclusiveDutchOrderReactor__factory.connect(
      execution.reactor,
      this.options.l1RpcProvider
    )
    const fillerNonce = await filler.getTransactionCount()
    const maxFeePerGas = (
      await this.options.l1RpcProvider.getFeeData()
    ).maxFeePerGas?.add(10000)
    const maxPriorityFeePerGas =
      maxFeePerGas || ethers.utils.parseUnits('1', 'gwei')

    const populatedTx = await reactor.populateTransaction.executeBatch(
      execution.orders.map((order) => {
        return {
          order: order.order.serialize(),
          sig: order.signature,
        }
      }),
      {
        gasLimit: BigNumber.from(700_000),
        nonce: fillerNonce,
        ...(maxFeePerGas && { maxFeePerGas }),
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        value,
      }
    )

    populatedTx.gasLimit = BigNumber.from(700_000)

    const tx = await filler.sendTransaction(populatedTx)
    const receipt = await tx.wait()

    return receipt.transactionHash
  }

  async main(): Promise<void> {
    // Parse options
    const minimumBotBalance = utils.parseEther(this.options.minimumBotBalance)

    await this.trackFaucetBalances()
    await this.trackOrders()

    for (const bot of this.state.bots) {
      await this.trackBotBalances(bot)
      console.log('Bot: ', bot.nickname)
      console.log('----------------------------------------------------')
      console.log('Address:    ', bot.address)
      console.log('ERC20A Balance:', utils.formatEther(bot.Erc20ABalance))
      console.log(
        'ERC20B Balance:',
        utils.formatUnits(bot.Erc20BBalance, this.state.erc20TokenB.decimals)
      )
      console.log('ETH Balance:', utils.formatEther(bot.EthBalance))
      await this.ensureMinimumBalances(bot)

      // if (
      //   bot.EthBalance.gt(minimumBotBalance) &&
      //   bot.Erc20BBalance.gt(minimumBotBalance)
      // ) {
      //   await this.runErc20Transfers(bot)
      // }

      await this.runFillOrders(bot)

      console.log('----------------------------------------------------')
      console.log('----------------------------------------------------')
    }

    return sleep(this.options.sleepTimeMs)
  }
}

if (require.main === module) {
  const service = new ERC20Bot()
  service.run()
}
