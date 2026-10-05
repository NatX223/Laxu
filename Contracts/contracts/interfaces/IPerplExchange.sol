// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @dev The slice of Perpl's Exchange that Laxu reads. Struct field order is copied from
 * `PerplFoundation/dex-sdk commit 01b9910` `crates/sdk/abi/dex/Exchange.json` (vendored, trimmed, at
 * `abi/perpl/Exchange.json`; regenerate with `node scripts/gen-perpl-iface.js`). The layout is
 * load-bearing -- a swapped field decodes as garbage, not as a revert -- so the fork test
 * (`test/fork/PerplReader.fork.js`) checks it against the live contract.
 *
 * Units: `*PNS` = price x 10^priceDecimals, `*LNS` = lots x 10^lotDecimals, `*CNS` = collateral
 * base units. Timestamps are unix seconds.
 */
interface IPerplExchange {
    struct PerpetualInfo {
        string name;
        string symbol;
        uint256 priceDecimals;
        uint256 lotDecimals;
        bytes32 linkFeedId;
        uint256 priceTolPer100K;
        uint256 marginTol;
        uint256 marginTolDecimals;
        uint256 refPriceMaxAgeSec;
        uint256 positionBalanceCNS;
        uint256 insuranceBalanceCNS;
        uint256 markPNS;
        uint256 markTimestamp;
        uint256 lastPNS;
        uint256 lastTimestamp;
        uint256 oraclePNS;
        uint256 oracleTimestampSec;
        uint256 longOpenInterestLNS;
        uint256 shortOpenInterestLNS;
        uint256 fundingStartBlock;
        int16 fundingRatePct100k;
        uint256 absFundingClampPctPer100K;
        uint8 status;
        uint256 basePricePNS;
        uint256 maxBidPriceONS;
        uint256 minBidPriceONS;
        uint256 maxAskPriceONS;
        uint256 minAskPriceONS;
        uint256 numOrders;
        bool ignOracle;
    }

    struct PositionInfo {
        uint256 accountId;
        uint256 nextNodeId;
        uint256 prevNodeId;
        uint8 positionType;
        uint256 depositCNS;
        uint256 pricePNS;
        uint256 lotLNS;
        uint256 entryBlock;
        int256 pnlCNS;
        int256 deltaPnlCNS;
        int256 premiumPnlCNS;
    }

    function getPerpetualInfo(uint256 perpId) external view returns (PerpetualInfo memory perpetualInfo);

    function getPosition(
        uint256 perpId,
        uint256 accountId
    ) external view returns (PositionInfo memory positionInfo, uint256 markPricePNS, bool markPriceValid);

    function isHalted() external view returns (bool halted);

    function getExchangeInfo()
        external
        view
        returns (
            uint256 balanceCNS,
            uint256 protocolBalanceCNS,
            uint256 recycleBalanceCNS,
            uint256 collateralDecimals,
            address collateralToken,
            address verifierProxy
        );
}
