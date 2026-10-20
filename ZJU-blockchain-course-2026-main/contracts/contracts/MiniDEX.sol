// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

// Uncomment the line to use openzeppelin/ERC721,ERC20
// You can use this dependency directly because it has been installed by TA already
// import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
// import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Uncomment this line to use console.log
// import "hardhat/console.sol";

contract MiniDEX {

    // use a event if you want
    // to represent time you can choose block.timestamp
    event PoolCreated(uint256 poolId, address tokenA, address tokenB);

    // maybe you need a struct to store some pool information
    struct Pool {
        address tokenA;
        address tokenB;
        uint256 reserveA;
        uint256 reserveB;
        uint256 createdTimestamp;
        // ...
    }

    mapping(uint256 => Pool) public pools; // A map from pool-index to its information
    // ...
    // TODO add any variables and functions if you want

    constructor() {
        // maybe you need a constructor
    }

    function helloworld() pure external returns(string memory) {
        return "hello world";
    }

    // ...
    // TODO add any logic if you want
}
