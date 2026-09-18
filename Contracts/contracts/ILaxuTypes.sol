// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev Long or short exposure. An enum (not a bool) so a future third state -- e.g. a
/// neutral/hedged strategy -- doesn't force a breaking rename; call sites read as
/// `direction == Direction.Short` rather than a bare `!isLong`.
///
/// Shared between {PositionToken} and {PositionTokenFactory} -- declaring it inside PositionToken
/// would force awkward qualification (`PositionToken.Direction`) at every other call site.
enum Direction {
    Long,
    Short
}
