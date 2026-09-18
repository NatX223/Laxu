// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Direction} from "./ILaxuTypes.sol";
import {IPositionToken} from "./IPositionToken.sol";

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
    address public positionTokenImplementation; // logic contract, deployed once, cloned many times

    /// @dev Gated caller for {createPosition}. Same real-world address as PositionToken's
    /// `arcusOperator`, but named differently here on purpose: in this Factory its only job is
    /// deploying position tokens, while inside PositionToken the same address gates fulfilling
    /// requests and closing positions -- meaningfully more than deploying. Do not rename
    /// PositionToken's `arcusOperator` to match this for consistency; that would erase a real
    /// distinction, not just tidy up naming.
    address public deployer;
    address public creForwarder; // CRE forwarder address, passed to every new clone
    address public usdg; // shared underlying asset address across all positions

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
    event CreForwarderUpdated(address newForwarder);

    constructor(
        address _implementation,
        address _deployer,
        address _creForwarder,
        address _usdg
    ) Ownable(msg.sender) {
        positionTokenImplementation = _implementation;
        deployer = _deployer;
        creForwarder = _creForwarder;
        usdg = _usdg;
    }

    /**
     * @dev Mints a new position after the backend has confirmed a real Arcus order filled --
     * entry price, size, and arcusPositionId come from that confirmation, not from an arbitrary
     * caller's say-so. Practical consequence: the backend pays gas for every position creation,
     * not the end user.
     */
    function createPosition(
        address creator,
        bytes32 market,
        Direction direction,
        uint256 leverage,
        uint256 entryPrice,
        uint256 size,
        uint256 initialDeposit,
        bytes32 arcusPositionId,
        uint256 creatorFeeBps
    ) external returns (address positionToken) {
        require(msg.sender == deployer, "not deployer");

        positionToken = Clones.clone(positionTokenImplementation);

        IPositionToken(positionToken).initialize(
            creator,
            market,
            direction,
            leverage,
            entryPrice,
            size,
            initialDeposit,
            arcusPositionId,
            usdg,
            creForwarder,
            deployer, // passed through -- becomes `arcusOperator` on the receiving side
            creatorFeeBps
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

    function setCreForwarder(address newForwarder) external onlyOwner {
        creForwarder = newForwarder;
        emit CreForwarderUpdated(newForwarder);
    }

    /// @dev Affects FUTURE clones only -- existing clones keep their original logic pointer.
    function setImplementation(address newImplementation) external onlyOwner {
        positionTokenImplementation = newImplementation;
    }
}
