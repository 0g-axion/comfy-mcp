/* Verbatim copies of operations in the indexer's PUBLIC read collection
 * (collection infinity-read-v1-public). The public indexer matches an
 * operation's document per NAME and refuses anything else with "query is not
 * allowed", so these are copied, never edited; inside the Comfy monorepo, tools.test.mjs pins each one
 * against the allowlist. The tools compose these base reads, filtered through `$where`. The market
 * collection (InfinityMarketBoard, InfinityPoolTrades, …) is served as well, but only
 * as its generated documents, which are not used here.
 *
 * Every one is scoped by `$deploymentId`, pages by `$after` in ascending id or cursor
 * order and answers at most 100 rows a page. They are synced from the
 * indexer allowlist when the collection changes. */

export const INFINITY_LAUNCHES = `query InfinityLaunches($deploymentId: String!, $after: String! = "", $limit: Int! = 50, $where: InfinityLaunch_bool_exp! = {}) {
  InfinityDeployment(where: {id: {_eq: $deploymentId}}, limit: 1) {
    id
    chainId
    contractCommit
    manager
    vault
    splitter
    controller
    executor
    computeRouter
    manifestHash
    manifest
    availability
    capabilities
    startBlock
    indexedThrough
    indexedBlockHash
    sourceTimestamp
    finalizedThrough
    finalizedBlockHash
    finalityStatus
    rows: launches(
      where: {_and: [$where, {cursor: {_gt: $after}}]}
      order_by: {cursor: asc}
      limit: $limit
    ) {
      id
      deploymentId
      poolKey
      tokenKey
      poolId
      token
      launcher
      creator
      mintedSupply
      ladderSupply
      openingTick
      launchFee
      seedSupplyUsed
      seedLiquidity
      rungCount
      blockNumber
      blockHash
      timestamp
      transactionHash
      transactionIndex
      logIndex
      cursor
    }
  }
}`;

export const INFINITY_TOKENS = `query InfinityTokens($deploymentId: String!, $after: String! = "", $limit: Int! = 50, $where: InfinityToken_bool_exp! = {}) {
  InfinityDeployment(where: {id: {_eq: $deploymentId}}, limit: 1) {
    id
    chainId
    contractCommit
    manager
    vault
    splitter
    controller
    executor
    computeRouter
    manifestHash
    manifest
    availability
    capabilities
    startBlock
    indexedThrough
    indexedBlockHash
    sourceTimestamp
    finalizedThrough
    finalizedBlockHash
    finalityStatus
    rows: tokens(
      where: {_and: [$where, {id: {_gt: $after}}]}
      order_by: {id: asc}
      limit: $limit
    ) {
      id
      deploymentId
      address
      origin
      launcher
      creator
      originalAdmin
      admin
      name
      symbol
      decimals
      image
      metadata
      context
      verified
      mintedSupply
      mintedTo
      totalSupply
      supplyCoverage
      holderCount
      createdBlock
      createdBlockHash
      createdTransactionHash
      launchedPoolKey
      updatedBlockNumber
      updatedBlockHash
    }
  }
}`;

export const INFINITY_POOLS = `query InfinityPools($deploymentId: String!, $after: String! = "", $limit: Int! = 50, $where: InfinityPool_bool_exp! = {}) {
  InfinityDeployment(where: {id: {_eq: $deploymentId}}, limit: 1) {
    id
    chainId
    contractCommit
    manager
    vault
    splitter
    controller
    executor
    computeRouter
    manifestHash
    manifest
    availability
    capabilities
    startBlock
    indexedThrough
    indexedBlockHash
    sourceTimestamp
    finalizedThrough
    finalizedBlockHash
    finalityStatus
    rows: pools(
      where: {_and: [$where, {id: {_gt: $after}}]}
      order_by: {id: asc}
      limit: $limit
    ) {
      id
      deploymentId
      chainId
      manager
      poolId
      kind
      hook
      currency0
      currency1
      parameters
      tickSpacing
      keyFee
      configuredLpFeePips
      storedProtocolFee
      initialized
      configuredLaunch
      completedLaunch
      tokenIsCurrency0
      creator
      baseFeeBps
      creatorTaxBps
      delayBlocks
      delaySeconds
      openingBps
      floorBps
      decaySeconds
      launchBlock
      launchTimestamp
      sqrtPriceX96
      currentTick
      activeLiquidity
      priceCurrency1PerCurrency0X18
      priceQuotePerTokenX18
      fdvQuote
      initializedSqrtPriceX96
      initializedAt
      candleCloseX18
      tradeCount
      executionTradeCount
      attributedTradeCount
      executionQuoteVolume
      attributionStatus
      isPriceSource
      usdBaseAssetId
      quoteUsdX18
      priceUsdX18
      tokenInPool
      quoteInPool
      circulatingSupply
      marketCapQuote
      marketCapUsdX18
      fdvUsdX18
      liquidityQuote
      liquidityUsdX18
      marketUpdatedAt
      executionTokenVolume
      executionQuoteVolumeUsdX18
      buyQuoteVolume
      sellQuoteVolume
      chargeQuote
      chargeUsdX18
      buyCount
      sellCount
      usdTradeCount
      usdCoverage
      traderCount
      lastTradeAt
      updatedBlockNumber
      updatedBlockHash
    }
  }
}`;

export const INFINITY_TRADES = `query InfinityTrades($deploymentId: String!, $after: String! = "", $limit: Int! = 50, $where: InfinityTrade_bool_exp! = {}) {
  InfinityDeployment(where: {id: {_eq: $deploymentId}}, limit: 1) {
    id
    chainId
    contractCommit
    manager
    vault
    splitter
    controller
    executor
    computeRouter
    manifestHash
    manifest
    availability
    capabilities
    startBlock
    indexedThrough
    indexedBlockHash
    sourceTimestamp
    finalizedThrough
    finalizedBlockHash
    finalityStatus
    rows: trades(
      where: {_and: [$where, {cursor: {_gt: $after}}]}
      order_by: {cursor: asc}
      limit: $limit
    ) {
      id
      deploymentId
      poolKey
      swapId
      currency0
      currency1
      managerAmount0
      managerAmount1
      actualSwapFeePips
      protocolFeePips
      swapFeePips
      lpFeePips
      openingFeePips
      feeAmountEstimated
      openingFeeQuoteEstimated
      feeAsset
      feeEstimateKind
      feeMatchesSchedule
      phase
      secondsSinceOpen
      chargeId
      router
      actor
      recipient
      exactInput
      attributionStatus
      executionStatus
      isBuy
      quoteCurrency
      tokenCurrency
      callerQuoteDelta
      callerTokenDelta
      executionQuoteAmount
      executionTokenAmount
      effectivePriceX18
      baseFee
      openingFee
      creatorTax
      spotPriceX18
      payer
      trader
      chargeQuote
      usdBaseAssetId
      quoteUsdX18
      executionQuoteAmountUsdX18
      chargeUsdX18
      spotPriceUsdX18
      effectivePriceUsdX18
      realizedPnlDeltaQuote
      pnlKnown
      blockNumber
      blockHash
      timestamp
      transactionHash
      transactionIndex
      logIndex
      cursor
    }
  }
}`;

export const INFINITY_CANDLES = `query InfinityCandles($deploymentId: String!, $after: String! = "", $limit: Int! = 50, $where: InfinityCandle_bool_exp! = {}) {
  InfinityDeployment(where: {id: {_eq: $deploymentId}}, limit: 1) {
    id
    chainId
    contractCommit
    manager
    vault
    splitter
    controller
    executor
    computeRouter
    manifestHash
    manifest
    availability
    capabilities
    startBlock
    indexedThrough
    indexedBlockHash
    sourceTimestamp
    finalizedThrough
    finalizedBlockHash
    finalityStatus
    rows: candles(
      where: {_and: [$where, {id: {_gt: $after}}]}
      order_by: {id: asc}
      limit: $limit
    ) {
      id
      deploymentId
      poolKey
      intervalSeconds
      bucketStart
      openX18
      highX18
      lowX18
      closeX18
      openUsdX18
      highUsdX18
      lowUsdX18
      closeUsdX18
      quoteUsdOpenX18
      quoteUsdCloseX18
      volumeQuote
      volumeToken
      volumeUsdX18
      buyVolumeQuote
      sellVolumeQuote
      chargeQuote
      openingFeeQuoteEstimated
      openingWindowBuys
      chargeUsdX18
      swapCount
      trades
      buys
      sells
      samples
      usdSamples
      volumeCoverage
      usdCoverage
      closeTick
      liquidityClose
      marketCapCloseQuote
      marketCapCloseUsdX18
      fdvCloseQuote
      fdvCloseUsdX18
      updatedBlockNumber
      updatedBlockHash
    }
  }
}`;
