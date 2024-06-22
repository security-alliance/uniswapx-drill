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
  DutchOrderBuilder,
} from '@uniswap/uniswapx-sdk'
import { UniswapXOrderEntity } from '../../lib/entities'
import axios from 'axios'

import { version } from '../../package.json'

import { Erc20TokenAbi } from '../../lib/abi/ERC20TokenAbi'
import { GetOrdersResponse } from '../../lib/handlers/get-orders/schema/GetOrdersResponse'
import { ChainId, DAI, PERMIT2, USDC } from '../../lib/constants'


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
  reactorOverrideAddress: string | undefined
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
  nonce: BigNumber
}

type ERC20Contract = {
  contract: ethers.Contract
  decimals: number
}

type State = {
  bots: Bot[]
  faucetSigner: Signer
  erc20TokenA: ERC20Contract
  erc20TokenB: ERC20Contract
}


const MAX_UINT256 = BigNumber.from(2).pow(256).sub(1)

export class ERC20Bot extends BaseServiceV2<Options, Metrics, State> {
  constructor(options?: Partial<Options & StandardOptions>) {
    super({
      version,
      name: 'uniswapx-swappers',
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
          default: 'https://eozojk18d0.execute-api.us-east-1.amazonaws.com/prod/',
          desc: 'UniswapX service URL',
        },
        defaultDeadlineSeconds: {
          validator: validators.num,
          default: 48,
          desc: 'Default deadline in seconds',
        },
        reactorOverrideAddress: {
          validator: validators.str,
          default: '',
          desc: 'Reactor override address',
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
        nonce: BigNumber.from(0),
        nickname: `Swapper-${i}`,
      })
      console.log(`Added Swapper signer ${signer.address}`)
    })
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
    const faucetERC20TxAmount = utils.parseEther(
      this.options.faucetErc20TxAmount
    )

    if (bot.EthBalance.lt(minimumBotBalance)) {
      console.log(
        `L1 signer ${bot.address} balance: ${bot.EthBalance} < ${minimumBotBalance}`
      )
      const faucetEthTx = await this.state.faucetSigner.sendTransaction({
        to: bot.address,
        value: faucetEthTxAmount,
      })
      await faucetEthTx.wait()
    }

    if (bot.Erc20ABalance < faucetERC20TxAmount) {
      console.log(
        `L1 signer ${bot.address} ERC20 balance: ${bot.Erc20ABalance} < ${faucetERC20TxAmount}`
      )
      const faucetERC20Tx = await this.state.faucetSigner.sendTransaction(
        await this.state.erc20TokenA.contract.populateTransaction.transfer(
          bot.address,
          faucetERC20TxAmount
        )
      )
      await faucetERC20Tx.wait()
    }
  }

  private async trackBotNonces(bot: Bot): Promise<void> {
    const nonce = await this.getNonce(bot)
    bot.nonce = nonce
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
    const faucetERC20Balance = await this.state.erc20TokenA.contract.balanceOf(
      faucetAddress
    )
    this.metrics.faucetBalance.set(parseInt(faucetBalance.toString(), 10))
    this.metrics.faucetErc20Balance.set(
      parseInt(faucetERC20Balance.toString(), 10)
    )
    console.log(`Faucet ERC20 balance: ${faucetERC20Balance}`)
  }

  private async runErc20Transfers(bot: Bot): Promise<void> {
    const transferAmount = bot.Erc20ABalance.div(3)
    const otherBot = this.getRandomOtherBot(bot)
    console.log(
      `Transferring ${utils.formatEther(transferAmount)} ERC20 from ${
        bot.address
      } to ${otherBot.address}`
    )
    const transferTx = await bot.signer.sendTransaction(
      await this.state.erc20TokenA.contract.populateTransaction.transfer(
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

  private async runPermit2Approvals(
    bot: Bot,
    tokenAddress: string
  ): Promise<void> {
    console.log(
      `Approving max ${tokenAddress} from ${bot.address} to ${PERMIT2}`
    )
    const approveTx = await bot.signer.sendTransaction(
      await this.state.erc20TokenA.contract.populateTransaction.approve(
        PERMIT2,
        MAX_UINT256
      )
    )
    await approveTx.wait()
  }
  
  private async getNonce(
    bot: Bot
  ): Promise<BigNumber> {
    const getResponse = await axios.get(`${this.options.uniswapXServiceUrl}dutch-auction/nonce?address=${bot.address}`)
    if (getResponse.status !== 200) {
      throw new Error(`Failed to get nonce: ${getResponse.statusText}`)
    }
    return BigNumber.from(getResponse.data.nonce)
  }

  private async runOrders(
    bot: Bot,
  ): Promise<void> {
    const swapAmountIn = bot.Erc20ABalance.div(3)
    const decimalDiff = this.state.erc20TokenA.decimals - this.state.erc20TokenB.decimals
    const swapAmountOut = swapAmountIn.div(BigNumber.from(10).pow(decimalDiff))
    const nonce = bot.nonce.add(1)
    const deadline = this.options.defaultDeadlineSeconds

    console.log(
      `Creating an order to swap ${utils.formatUnits(swapAmountIn, this.state.erc20TokenA.decimals)} ${this.state.erc20TokenA.contract.address} for ${utils.formatUnits(swapAmountOut, this.state.erc20TokenB.decimals)} ${this.state.erc20TokenB.contract.address} as bot ${bot.address}`
    )

    const order = await this.buildOrder(
      bot,
      swapAmountIn,
      swapAmountOut,
      deadline,
      this.state.erc20TokenA.contract.address,
      this.state.erc20TokenB.contract.address,
      nonce
    )
    console.log(`Created order: ${JSON.stringify(order)}`)
    await this.submitOrder(order.payload)
  }

  private async buildOrder(
    swapper: Bot,
    amountIn: BigNumber,
    amountOut: BigNumber,
    deadlineSeconds: number,
    inputToken: string,
    outputToken: string,
    nonce: BigNumber
    // filler?: string,
  ): Promise<{
    order: DutchOrder
    payload: { encodedOrder: string; signature: string; chainId: ChainId }
  }> {
    const deadline = Math.round(new Date().getTime() / 1000) + deadlineSeconds
    const decayStartTime = Math.round(new Date().getTime() / 1000)
    const order = new DutchOrderBuilder(this.options.testChainId)
      .deadline(deadline)
      .decayEndTime(deadline)
      .decayStartTime(decayStartTime)
      .swapper(swapper.address)
      // .exclusiveFiller(filler.address, BigNumber.from(100))
      .nonce(nonce)
      .input({
        token: inputToken,
        // limit orders have all start amounts = all endamounts: e.g.
        // input.startAmount==input.endAmount && all(outputs[i].startAmount==outputs[i].endAmount)
        // and this test is for dutch orders
        startAmount: amountIn,
        endAmount: amountIn,
      })
      .output({
        token: outputToken,
        startAmount: amountOut,
        endAmount: amountOut.mul(9).div(10),
        recipient: swapper.address,
      })
      .build()
      
    if (this.options.reactorOverrideAddress !== '') {
      order.info.reactor = this.options.reactorOverrideAddress
    }

    const { domain, types, values } = order.permitData()
    const signature = await swapper.signer._signTypedData(domain, types, values)
    const encodedOrder = order.serialize()

    return {
      order,
      payload: {
        encodedOrder: encodedOrder,
        signature: signature,
        chainId: this.options.testChainId,
      },
    }
  }

  private async submitOrder(
    payload: {
      encodedOrder: string
      signature: string
      chainId: ChainId,
      orderType?: string,
      quoteId?: string,
    }
  ): Promise<void> {
    try {
      const postResponse = await axios({
        method: 'post',
        url: `${this.options.uniswapXServiceUrl}dutch-auction/order`,
        data: payload,
      })
      if (postResponse.status !== 201) {
        throw new Error(`Failed to submit order: ${postResponse.statusText}`)
        // TODO track metrics of failed orders
      }
    } catch (err: any) {
      console.log(err.message)
      throw err
    }
  }

  async main(): Promise<void> {
    // Parse options
    const minimumBotBalance = utils.parseEther(this.options.minimumBotBalance)

    await this.trackFaucetBalances()
    // await this.trackOrders()

    for (const bot of this.state.bots) {
      await this.trackBotBalances(bot)
      await this.trackBotNonces(bot)
      console.log('Bot: ', bot.nickname)
      console.log('----------------------------------------------------')
      console.log('Address:    ', bot.address)
      console.log('ERC20A Balance:', utils.formatEther(bot.Erc20ABalance))
      console.log('ERC20B Balance:', utils.formatEther(bot.Erc20BBalance))
      console.log('ETH Balance:', utils.formatEther(bot.EthBalance))
      console.log('Nonce:', bot.nonce.toHexString())
      await this.ensureMinimumBalances(bot)

      if (
        bot.EthBalance.gt(minimumBotBalance) &&
        bot.Erc20ABalance.gt(minimumBotBalance)
      ) {
        await this.runErc20Transfers(bot)
      }

      const approval = await this.state.erc20TokenA.contract.allowance(
        bot.address,
        PERMIT2
      )
      if (approval.lt(MAX_UINT256)) {
        await this.runPermit2Approvals(bot, DAI)
      }
      
      await this.runOrders(bot)

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
