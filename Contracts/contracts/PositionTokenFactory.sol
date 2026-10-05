// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Direction} from "./ILaxuTypes.sol";
import {IPositionToken} from "./IPositionToken.sol";
import {IVenueReader} from "./interfaces/IVenueReader.sol";

/**
 * @title PositionTokenFactory
 * @dev Deploys and registers {PositionToken} clones. Unlike PositionToken, this contract is not
 * itself a clone -- deployed once, for real, via a normal constructor.
 *
 * Every position gets its own real, independent contract address: {Clones-clone} deploys a fresh
 * EIP-1167 minimal proxy per call, each with its own storage, ERC-20 balances, and totalSupply().
 * Only the logic bytecode ({positionTokenImplementation}) is shared -- that's what makes cloning
 * cheap, not what makes positions fungible with each other.
 */
contract PositionTokenFactory is Ownable {
    /// @dev The lending tiers stop at 20x (see {LendingPool-_riskTierFor}).
    uint256 public constant MAX_LEVERAGE = 20;

    address public positionTokenImplementation; // logic contract, deployed once, cloned many times

    /// @dev Gated caller for {createPosition}. Same real-world address as PositionToken's
    /// `operator`, but named differently here on purpose: in this Factory its only job is
    /// deploying position tokens, while inside PositionToken the same address gates fulfilling
    /// requests and closing positions -- meaningfully more than deploying.
    address public deployer;
    /// @dev Shared underlying asset across all positions: the venue's collateral token.
    address public asset;
    /// @dev Handed to every new position; each token keeps the reader it was created with.
    IVenueReader public venueReader;

    address[] public allPositions;
    mapping(address => address[]) public positionsByCreator;
    mapping(bytes32 => address[]) public positionsByMarket;

    event PositionCreated(
        address indexed positionToken,
        address indexed creator,
        bytes32 market,
        Direction direction,
        uint256 leverage
    );
    event DeployerUpdated(address newDeployer);
    event VenueReaderUpdated(address newVenueReader);

    constructor(
        address _implementation,
        address _deployer,
        address _asset,
        address _venueReader
    ) Ownable(msg.sender) {
        require(_venueReader != address(0), "zero venue reader");
        positionTokenImplementation = _implementation;
        deployer = _deployer;
        asset = _asset;
        venueReader = IVenueReader(_venueReader);
    }

    /// @dev Back-compat alias for {asset}: the backend discovers the asset via `usdg()`.
    function usdg() external view returns (address) {
        return asset;
    }

    /**
     * @dev Mints a new position after the backend has opened a real venue position. The token's
     * {PositionToken-initialize} checks direction, size and entry against the venue position held
     * by `venueAccountId`, so the operator can't mint a token for a trade that doesn't exist.
     * `size` / `entryPrice` must be computed with {PerplReader-toSize} / {PerplReader-toPrice} from
     * the venue's own `lotLNS` / `pricePNS`. Practical consequence: the backend pays gas for every
     * position creation, not the end user.
     *
     * `defaultStopLoss` / `defaultTakeProfit` are the creator's SL/TP (PRICE_SCALE prices of the
     * underlying, 0 = none): the defaults for every holder who doesn't set their own.
     */
    function createPosition(
        address creator,
        bytes32 market,
        Direction direction,
        uint256 leverage,
        uint256 entryPrice,
        uint256 size,
        uint256 initialDeposit,
        bytes32 venuePositionId,
        uint256 venueAccountId,
        uint256 defaultStopLoss,
        uint256 defaultTakeProfit
    ) external returns (address positionToken) {
        require(msg.sender == deployer, "not deployer");
        require(leverage >= 1 && leverage <= MAX_LEVERAGE, "leverage out of range");

        positionToken = Clones.clone(positionTokenImplementation);

        IPositionToken(positionToken).initialize(
            creator,
            market,
            direction,
            leverage,
            entryPrice,
            size,
            initialDeposit,
            venuePositionId,
            asset,
            deployer, // passed through -- becomes `operator` on the receiving side
            address(venueReader),
            venueAccountId,
            defaultStopLoss,
            defaultTakeProfit
        );

        allPositions.push(positionToken);
        positionsByCreator[creator].push(positionToken);
        positionsByMarket[market].push(positionToken);

        emit PositionCreated(positionToken, creator, market, direction, leverage);
    }

    // ---------------------------------------------------------------------
    // Views -- marketplace/portfolio UI
    // ---------------------------------------------------------------------

    function allPositionsCount() external view returns (uint256) {
        return allPositions.length;
    }

    function getPositionsByCreator(address creator) external view returns (address[] memory) {
        return positionsByCreator[creator];
    }

    function getPositionsByMarket(bytes32 market) external view returns (address[] memory) {
        return positionsByMarket[market];
    }

    // ---------------------------------------------------------------------
    // Admin -- rotate keys/addresses without redeploying everything
    // ---------------------------------------------------------------------

    function setDeployer(address newDeployer) external onlyOwner {
        deployer = newDeployer;
        emit DeployerUpdated(newDeployer);
    }

    /// @dev Affects FUTURE positions only -- existing tokens keep the reader they were created with.
    function setVenueReader(address newVenueReader) external onlyOwner {
        require(newVenueReader != address(0), "zero venue reader");
        venueReader = IVenueReader(newVenueReader);
        emit VenueReaderUpdated(newVenueReader);
    }

    /// @dev Affects FUTURE clones only -- existing clones keep their original logic pointer.
    function setImplementation(address newImplementation) external onlyOwner {
        positionTokenImplementation = newImplementation;
    }
}
