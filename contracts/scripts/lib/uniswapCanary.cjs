/**
 * Shared pieces for the mainnet canary and its fork rehearsal.
 *
 * The rehearsal and the real run MUST use the same code path, or the rehearsal proves nothing.
 * Everything here is therefore network-agnostic: the caller supplies signers and a provider.
 *
 * The proving BUY goes through Uniswap's own UniversalRouter rather than our test-only
 * V4TestSwapRouter, so no test code is ever deployed to mainnet.
 */
const { ethers } = require('ethers');

/** Official Uniswap deployment on Robinhood Chain mainnet (4663), registry status "active". */
const U = {
  liquidityLauncher: '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0',
  instantLaunchStrategy: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1',
  feeSplitter: '0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf',
  beneficiaryVault: '0xd35E9CA72F64C7F93BE30fad67524323396B36D7',
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  universalRouter: '0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99',
};

/** The pool InstantLaunchStrategy creates: native ETH / token, 25 bps, spacing 25, no hook. */
const LP_FEE = 2500;
const TICK_SPACING = 25;

function poolKeyFor(token) {
  return {
    currency0: ethers.ZeroAddress,
    currency1: ethers.getAddress(token),
    fee: LP_FEE,
    tickSpacing: TICK_SPACING,
    hooks: ethers.ZeroAddress,
  };
}

// --- UniversalRouter / v4 encoding ------------------------------------------------------------
// UniversalRouter command byte for a v4 swap.
const CMD_V4_SWAP = 0x10;
// v4-periphery Actions.
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;

const coder = ethers.AbiCoder.defaultAbiCoder();

const POOL_KEY_TYPE = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const EXACT_IN_SINGLE_TYPE =
  `(${POOL_KEY_TYPE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`;

/**
 * Encodes a native-ETH exact-input BUY of `token` for the UniversalRouter.
 *
 * currency0 is native ETH and currency1 is the token, so a buy is zeroForOne: pay ETH, take token.
 * SETTLE_ALL pays the ETH we owe; TAKE_ALL collects the token we are owed.
 */
function encodeBuy({ token, amountIn, amountOutMinimum = 0n }) {
  const key = poolKeyFor(token);
  const actions = ethers.concat([
    Uint8Array.of(ACTION_SWAP_EXACT_IN_SINGLE),
    Uint8Array.of(ACTION_SETTLE_ALL),
    Uint8Array.of(ACTION_TAKE_ALL),
  ]);

  const params = [
    coder.encode([EXACT_IN_SINGLE_TYPE], [[
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      true, amountIn, amountOutMinimum, '0x',
    ]]),
    coder.encode(['address', 'uint256'], [ethers.ZeroAddress, amountIn]),
    coder.encode(['address', 'uint256'], [token, amountOutMinimum]),
  ];

  const commands = ethers.hexlify(Uint8Array.of(CMD_V4_SWAP));
  const inputs = [coder.encode(['bytes', 'bytes[]'], [actions, params])];
  return { commands, inputs };
}

const routerAbi = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];
const splitterAbi = [
  'function collectFees(uint256[] tokenIds)',
  'function getSplits() view returns (tuple(address recipient,uint16 nativeBps,uint16 tokenBps,bool useCallback)[])',
  'event FeesCollected(uint256 indexed tokenId, address indexed token, uint256 nativeAmount, uint256 tokenAmount)',
];
const vaultAbi = [
  'function amounts(uint256) view returns (uint256, uint256)',
  'function ownerOf(uint256) view returns (address)',
];

/** Executes the proving buy through Uniswap's UniversalRouter. Returns the receipt. */
async function buyThroughUniversalRouter({ signer, token, amountIn, deadlineSeconds = 1800 }) {
  const router = new ethers.Contract(U.universalRouter, routerAbi, signer);
  const { commands, inputs } = encodeBuy({ token, amountIn });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  const tx = await router.execute(commands, inputs, deadline, { value: amountIn });
  return tx.wait();
}

/** Collects LP fees for a position and returns the amounts Uniswap actually realised. */
async function collectPoolFees({ signer, positionTokenId }) {
  const splitter = new ethers.Contract(U.feeSplitter, splitterAbi, signer);
  const receipt = await (await splitter.collectFees([positionTokenId])).wait();
  const parsed = receipt.logs
    .map((l) => { try { return splitter.interface.parseLog(l); } catch { return null; } })
    .find((p) => p && p.name === 'FeesCollected');
  return {
    receipt,
    nativeFee: parsed ? parsed.args.nativeAmount : 0n,
    tokenFee: parsed ? parsed.args.tokenAmount : 0n,
  };
}

module.exports = {
  U, LP_FEE, TICK_SPACING, poolKeyFor,
  encodeBuy, buyThroughUniversalRouter, collectPoolFees,
  routerAbi, splitterAbi, vaultAbi,
};
