// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IPerplExchange} from "../interfaces/IPerplExchange.sol";

/// @dev Test-only, settable stand-in for Perpl's Exchange. Only the fields PerplReader reads are
/// settable; the rest stay zero.
contract MockPerplExchange is IPerplExchange {
    mapping(uint256 => PerpetualInfo) internal _perps;
    mapping(uint256 => mapping(uint256 => PositionInfo)) internal _positions;
    bool public halted;
    bool public reverting;
    uint256 internal _collateralDecimals = 6;
    address internal _collateralToken;

    function setPerp(
        uint256 perpId,
        uint256 priceDecimals,
        uint256 lotDecimals,
        uint256 markPNS,
        uint256 markTimestamp,
        uint256 refPriceMaxAgeSec,
        uint8 status
    ) external {
        PerpetualInfo storage p = _perps[perpId];
        p.priceDecimals = priceDecimals;
        p.lotDecimals = lotDecimals;
        p.markPNS = markPNS;
        p.markTimestamp = markTimestamp;
        p.refPriceMaxAgeSec = refPriceMaxAgeSec;
        p.status = status;
    }

    function setPosition(
        uint256 perpId,
        uint256 accountId,
        uint8 positionType,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 depositCNS,
        int256 pnlCNS
    ) external {
        PositionInfo storage p = _positions[perpId][accountId];
        p.accountId = accountId;
        p.positionType = positionType;
        p.pricePNS = pricePNS;
        p.lotLNS = lotLNS;
        p.depositCNS = depositCNS;
        p.pnlCNS = pnlCNS;
    }

    function setHalted(bool h) external {
        halted = h;
    }

    function setRevert(bool r) external {
        reverting = r;
    }

    function setExchangeInfo(uint256 collateralDecimals, address collateralToken) external {
        _collateralDecimals = collateralDecimals;
        _collateralToken = collateralToken;
    }

    function getPerpetualInfo(uint256 perpId) external view returns (PerpetualInfo memory) {
        require(!reverting, "MockPerplExchange: reverting");
        return _perps[perpId];
    }

    function getPosition(uint256 perpId, uint256 accountId) external view returns (PositionInfo memory, uint256, bool) {
        require(!reverting, "MockPerplExchange: reverting");
        return (_positions[perpId][accountId], _perps[perpId].markPNS, true);
    }

    function isHalted() external view returns (bool) {
        require(!reverting, "MockPerplExchange: reverting");
        return halted;
    }

    function getExchangeInfo() external view returns (uint256, uint256, uint256, uint256, address, address) {
        require(!reverting, "MockPerplExchange: reverting");
        return (0, 0, 0, _collateralDecimals, _collateralToken, address(0));
    }
}
