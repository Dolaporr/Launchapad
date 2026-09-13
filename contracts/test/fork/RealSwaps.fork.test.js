const { expect } = require('chai');
const { ethers, network } = require('hardhat');

/**
 * MILESTONE 2.5 — REAL-SWAP FORK VALIDATION.
 *
 * Everything here is real: the Uniswap Liquidity Launchpad, the v4 PoolManager, the pool created
 * by our launch, actual BUY and SELL swaps executed against that pool, the fees those swaps
 * generate, Uniswap's FeeSplitter collecting them, and the vault paying our splitter.
 *
 * NOTHING IS INJECTED. There is no `onAmountsReceived` impersonation anywhere in this file — the
 * only way ETH reaches LaunchpadRewards is by someone trading.
 *
 *   FORK_RPC=https://rpc.mainnet.chain.robinhood.com npm run test:swaps
 */
const FORK_RPC = process.env.FORK_RPC;
const describeFork = FORK_RPC ? describe : describe.skip;

const U = {
  liquidityLauncher: '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0',
  instantLaunchStrategy: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1',
  feeSplitter: '0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf',
  beneficiaryVault: '0xd35E9CA72F64C7F93BE30fad67524323396B36D7',
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
};

const LP_FEE_BPS = 25n;
const VAULT_ETH_SHARE_BPS = 4000n; // 40%, read from FeeSplitter.getSplits()
const BPS = 10000n;

const splitterAbi = [
  'function collectFees(uint256[] tokenIds)',
  'function getSplits() view returns (tuple(address recipient,uint16 nativeBps,uint16 tokenBps,bool useCallback)[])',
  'event FeesCollected(uint256 indexed tokenId, address indexed token, uint256 nativeAmount, uint256 tokenAmount)',
];
const vaultAbi = ['function amounts(uint256) view returns (uint256, uint256)', 'function ownerOf(uint256) view returns (address)'];

/** The pool key InstantLaunchStrategy creates: native ETH / token, 25 bps, spacing 25, no hook. */
const poolKeyFor = (token) => ({
  currency0: ethers.ZeroAddress, currency1: token, fee: 2500, tickSpacing: 25, hooks: ethers.ZeroAddress,
});

describeFork('FORK 2.5: REAL swaps generate the real creator-fee stream', function () {
  this.timeout(900000);

  let deployer, padOwner, creator, protocol, trader, keeper;
  let factory, launcher, rewards, router, pad;
  let splitter, vault;

  before(async () => {
    await network.provider.send('evm_mine');
    [deployer, padOwner, creator, protocol, trader, keeper] = await ethers.getSigners();

    splitter = new ethers.Contract(U.feeSplitter, splitterAbi, deployer);
    vault = new ethers.Contract(U.beneficiaryVault, vaultAbi, ethers.provider);

    factory = await (await ethers.getContractFactory('LaunchpadFactory'))
      .deploy(protocol.address, ethers.ZeroAddress);
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
    launcher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
      await factory.getAddress(), U.liquidityLauncher, U.instantLaunchStrategy,
      U.beneficiaryVault, U.positionManager, predicted,
    );
    rewards = await (await ethers.getContractFactory('LaunchpadRewards'))
      .deploy(U.beneficiaryVault, await launcher.getAddress(), protocol.address);

    router = await (await ethers.getContractFactory('V4TestSwapRouter')).deploy(U.poolManager);

    await factory.connect(padOwner).createLaunchpad('Swap Pad', '', 0, 1);
    pad = await factory.launchpads(0);
  });

  /** Launches a fresh token and returns its handles. */
  async function freshLaunch(signer, name, symbol) {
    const before = await launcher.tokenCount();
    await launcher.connect(signer).launch(pad, name, symbol);
    const token = await launcher.allTokens(before);
    const tokenId = (await launcher.launchOf(token)).positionTokenId;
    return { token, tokenId, erc20: await ethers.getContractAt('LaunchToken', token), key: poolKeyFor(token) };
  }

  /** Collects fees from the pool position and returns the LP fee amounts actually realised. */
  async function collectFromPool(tokenId) {
    const receipt = await (await splitter.collectFees([tokenId])).wait();
    const parsed = receipt.logs
      .map((l) => { try { return splitter.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === 'FeesCollected');
    return { nativeFee: parsed ? parsed.args.nativeAmount : 0n, tokenFee: parsed ? parsed.args.tokenAmount : 0n };
  }

  // --------------------------------------------------------------------------------------------

  describe('1 + 2. A real BUY: 25 bps LP fee, 40% of the ETH side reaches the creator path', () => {
    let launch;
    const BUY = ethers.parseEther('1');

    before(async () => {
      launch = await freshLaunch(creator, 'Buy Proof', 'BUYP');
      await router.connect(trader).buyExactIn(launch.key, BUY, trader.address, { value: BUY });
    });

    it('the trader actually received tokens from the pool', async () => {
      expect(await launch.erc20.balanceOf(trader.address)).to.be.greaterThan(0n);
    });

    it('PROOF 1: the pool charged 25 bps of the ETH input (rounded up by 1 wei)', async () => {
      const { nativeFee, tokenFee } = await collectFromPool(launch.tokenId);
      const exact = (BUY * LP_FEE_BPS) / BPS; // 0.0025 ETH
      // MEASURED: Uniswap rounds the fee UP in the pool's favour, so the realised fee is
      // exact or exact+1 wei. Asserting the band rather than a point value documents that.
      expect(nativeFee).to.be.at.least(exact);
      expect(nativeFee).to.be.at.most(exact + 1n);
      expect(tokenFee).to.equal(0n); // a buy pays its fee in ETH only
    });

    it('PROOF 2: exactly 40% of that ETH fee was attributed to our position in the vault', async () => {
      const [nativeAttributed, tokenAttributed] = await vault.amounts(launch.tokenId);
      const lpFee = (BUY * LP_FEE_BPS) / BPS;
      expect(nativeAttributed).to.equal((lpFee * VAULT_ETH_SHARE_BPS) / BPS);
      expect(nativeAttributed).to.equal(ethers.parseEther('0.001')); // 40% x 25bps x 1 ETH
      expect(tokenAttributed).to.equal(0n);
    });

    it('the effective rate on buy volume is 10 bps to our stream', async () => {
      const [nativeAttributed] = await vault.amounts(launch.tokenId);
      // 10 bps of the 1 ETH traded.
      expect((nativeAttributed * BPS) / BUY).to.equal(10n);
    });
  });

  describe('3. A real SELL produces ZERO creator stream', () => {
    let launch;
    const BUY = ethers.parseEther('2');

    before(async () => {
      launch = await freshLaunch(creator, 'Sell Proof', 'SELP');
      await router.connect(trader).buyExactIn(launch.key, BUY, trader.address, { value: BUY });
      // Drain the buy-side fees first so the next collection isolates the sell.
      await collectFromPool(launch.tokenId);
      await rewards.collectAndSplit(launch.tokenId);
    });

    it('a sell charges its LP fee in the TOKEN, not in ETH', async () => {
      const balance = await launch.erc20.balanceOf(trader.address);
      await launch.erc20.connect(trader).approve(await router.getAddress(), balance);
      await router.connect(trader).sellExactIn(launch.key, balance / 2n, trader.address);

      const { nativeFee, tokenFee } = await collectFromPool(launch.tokenId);
      expect(tokenFee).to.be.greaterThan(0n, 'the sell should have produced a token-side fee');
      // The tiny native amount here is only what the sell's price impact returned to the range,
      // not a fee on the sell itself.
      expect(tokenFee).to.be.greaterThan(nativeFee);
    });

    it('PROOF 3: none of the token-side fee reaches our creator stream', async () => {
      const [, tokenAttributed] = await vault.amounts(launch.tokenId);
      expect(tokenAttributed).to.equal(0n);
    });

    it('the splitter is configured to send 0% of the token side to the vault', async () => {
      const splits = await splitter.getSplits();
      const toVault = splits.find((s) => s.recipient.toLowerCase() === U.beneficiaryVault.toLowerCase());
      expect(Number(toVault.tokenBps)).to.equal(0);
      expect(Number(toVault.nativeBps)).to.equal(4000);
    });
  });

  describe('4 + 5. LaunchpadRewards claims the real stream and splits it 50 / 30 / 20', () => {
    let launch;
    const BUY = ethers.parseEther('4');

    let pendingBefore;

    before(async () => {
      launch = await freshLaunch(creator, 'Split Proof', 'SPLP');
      await router.connect(trader).buyExactIn(launch.key, BUY, trader.address, { value: BUY });
      await collectFromPool(launch.tokenId);
      // These signers already hold pending balances from earlier describes, so every assertion
      // below is a DELTA. Absolute balances would be testing the order of the file.
      pendingBefore = {
        creator: await rewards.pending(creator.address),
        padOwner: await rewards.pending(padOwner.address),
        protocol: await rewards.pending(protocol.address),
      };
    });

    it('PROOF 4: rewards holds the claim and receives the real ETH', async () => {
      expect((await vault.ownerOf(launch.tokenId)).toLowerCase())
        .to.equal((await rewards.getAddress()).toLowerCase());

      const [attributed] = await vault.amounts(launch.tokenId);
      const expected = (((BUY * LP_FEE_BPS) / BPS) * VAULT_ETH_SHARE_BPS) / BPS;
      expect(attributed).to.equal(expected);

      const before = await ethers.provider.getBalance(await rewards.getAddress());
      await rewards.connect(keeper).collectAndSplit(launch.tokenId);
      const after = await ethers.provider.getBalance(await rewards.getAddress());
      expect(after - before).to.equal(expected);
    });

    it('PROOF 5: creator / pad owner / protocol are credited exactly 50 / 30 / 20 of it', async () => {
      const claimed = (((BUY * LP_FEE_BPS) / BPS) * VAULT_ETH_SHARE_BPS) / BPS; // 0.004 ETH
      expect(await rewards.pending(creator.address) - pendingBefore.creator).to.equal((claimed * 50n) / 100n);
      expect(await rewards.pending(padOwner.address) - pendingBefore.padOwner).to.equal((claimed * 30n) / 100n);
      expect(await rewards.pending(protocol.address) - pendingBefore.protocol).to.equal((claimed * 20n) / 100n);
      // The keeper who triggered the collection earns nothing from it.
      expect(await rewards.pending(keeper.address)).to.equal(0n);
    });

    it('PROOF 5b: each party withdraws exactly what it was owed, in real ETH', async () => {
      for (const party of [creator, padOwner, protocol]) {
        const owed = await rewards.pending(party.address);
        expect(owed).to.be.greaterThan(0n);
        await expect(rewards.withdrawFor(party.address)).to.changeEtherBalance(party, owed);
        expect(await rewards.pending(party.address)).to.equal(0n);
      }
    });
  });

  describe('6. Wei conservation across repeated trades and repeated collections', () => {
    let launch;

    before(async () => {
      launch = await freshLaunch(creator, 'Stress Proof', 'STRP');
    });

    it('survives small, large, odd-sized and repeated buys with sells interleaved', async () => {
      const buys = [
        1n,                                  // 1 wei — rounding floor
        999n,                                // sub-fee-unit
        ethers.parseEther('0.000001'),       // dust
        ethers.parseEther('0.3333333333'),   // non-round
        ethers.parseEther('1'),
        ethers.parseEther('7'),              // large
      ];

      let totalBuyVolume = 0n;
      for (const amount of buys) {
        await router.connect(trader).buyExactIn(launch.key, amount, trader.address, { value: amount });
        totalBuyVolume += amount;
      }

      // Partial sells in between, which must not add to the creator stream.
      const balance = await launch.erc20.balanceOf(trader.address);
      await launch.erc20.connect(trader).approve(await router.getAddress(), balance);
      await router.connect(trader).sellExactIn(launch.key, balance / 4n, trader.address);
      await router.connect(trader).sellExactIn(launch.key, balance / 8n, trader.address);

      // Collect once at the end.
      const { nativeFee } = await collectFromPool(launch.tokenId);
      // Each buy is floored independently, so the total can be under the ideal by at most 1 wei per buy.
      const ideal = (totalBuyVolume * LP_FEE_BPS) / BPS;
      expect(nativeFee).to.be.at.most(ideal + BigInt(buys.length));
      expect(nativeFee).to.be.at.least(ideal - BigInt(buys.length));

      const [attributed] = await vault.amounts(launch.tokenId);
      expect(attributed).to.equal((nativeFee * VAULT_ETH_SHARE_BPS) / BPS);
    });

    it('splits the accumulated stream with no wei lost', async () => {
      const [attributed] = await vault.amounts(launch.tokenId);
      const beforeCreator = await rewards.pending(creator.address);
      const beforePad = await rewards.pending(padOwner.address);
      const beforeProtocol = await rewards.pending(protocol.address);

      await rewards.collectAndSplit(launch.tokenId);

      const gained = (await rewards.pending(creator.address) - beforeCreator)
        + (await rewards.pending(padOwner.address) - beforePad)
        + (await rewards.pending(protocol.address) - beforeProtocol);
      expect(gained).to.equal(attributed);
      expect(await rewards.unaccountedBalance()).to.equal(0n);
    });

    it('collecting again with nothing new accrued is refused, not a silent zero split', async () => {
      await expect(rewards.collectAndSplit(launch.tokenId))
        .to.be.revertedWithCustomError(rewards, 'NothingClaimed');
    });

    it('a further trade accrues again and settles correctly (collect -> trade -> collect)', async () => {
      const amount = ethers.parseEther('2');
      await router.connect(trader).buyExactIn(launch.key, amount, trader.address, { value: amount });
      await collectFromPool(launch.tokenId);

      const [attributed] = await vault.amounts(launch.tokenId);
      expect(attributed).to.equal(((amount * LP_FEE_BPS) / BPS * VAULT_ETH_SHARE_BPS) / BPS);

      const before = await rewards.pending(protocol.address);
      await rewards.collectAndSplit(launch.tokenId);
      expect(await rewards.pending(protocol.address) - before).to.equal((attributed * 20n) / 100n);
      expect(await rewards.totalPending()).to.equal(
        await ethers.provider.getBalance(await rewards.getAddress()),
      );
    });
  });

  describe('7. A reverting recipient cannot block the other two — with REAL fees', () => {
    it('the pad owner and protocol still withdraw when the creator refuses ETH', async () => {
      const rejecting = await (await ethers.getContractFactory('RejectingBeneficiary')).deploy();
      const rejectingAddress = await rejecting.getAddress();

      await network.provider.send('hardhat_impersonateAccount', [rejectingAddress]);
      await network.provider.send('hardhat_setBalance', [rejectingAddress, '0x56BC75E2D63100000']);
      const asRejecting = await ethers.getSigner(rejectingAddress);
      const before = await launcher.tokenCount();
      await launcher.connect(asRejecting).launch(pad, 'Blocked', 'BLK');
      await network.provider.send('hardhat_stopImpersonatingAccount', [rejectingAddress]);

      const token = await launcher.allTokens(before);
      const tokenId = (await launcher.launchOf(token)).positionTokenId;

      const amount = ethers.parseEther('1');
      await router.connect(trader).buyExactIn(poolKeyFor(token), amount, trader.address, { value: amount });
      await collectFromPool(tokenId);
      await rewards.collectAndSplit(tokenId);

      const claimed = (((amount * LP_FEE_BPS) / BPS) * VAULT_ETH_SHARE_BPS) / BPS;

      // Withdraw whatever each healthy party is owed; the point is that they CAN, while the
      // broken recipient cannot.
      for (const party of [padOwner, protocol]) {
        const owed = await rewards.pending(party.address);
        expect(owed).to.be.greaterThan(0n);
        await expect(rewards.withdrawFor(party.address)).to.changeEtherBalance(party, owed);
      }

      await expect(rewards.withdrawFor(rejectingAddress))
        .to.be.revertedWithCustomError(rewards, 'TransferFailed');
      // The blocked share stays credited — not lost, not redistributed to anyone else.
      expect(await rewards.pending(rejectingAddress)).to.equal((claimed * 50n) / 100n);
    });
  });

  describe('8. Multiple real pools settle through the same singleton rewards contract', () => {
    it('accrues and settles three pools independently from real trades', async () => {
      const creators = (await ethers.getSigners()).slice(6, 9);
      const launches = [];
      for (const [i, c] of creators.entries()) {
        launches.push({ signer: c, ...(await freshLaunch(c, `Multi ${i}`, `M${i}`)) });
      }

      const amounts = [ethers.parseEther('1'), ethers.parseEther('2'), ethers.parseEther('3')];
      for (const [i, l] of launches.entries()) {
        await router.connect(trader).buyExactIn(l.key, amounts[i], trader.address, { value: amounts[i] });
        await collectFromPool(l.tokenId);
      }

      const protocolBefore = await rewards.pending(protocol.address);
      const padBefore = await rewards.pending(padOwner.address);

      for (const l of launches) await rewards.collectAndSplit(l.tokenId);

      let expectedProtocol = 0n;
      let expectedPad = 0n;
      for (const [i, l] of launches.entries()) {
        const stream = (((amounts[i] * LP_FEE_BPS) / BPS) * VAULT_ETH_SHARE_BPS) / BPS;
        // Each creator earns only from their own pool.
        expect(await rewards.pending(l.signer.address)).to.equal((stream * 50n) / 100n);
        expectedProtocol += (stream * 20n) / 100n;
        expectedPad += (stream * 30n) / 100n;
      }

      // The pad owner and protocol accumulate across all three, in one deployment.
      expect(await rewards.pending(protocol.address) - protocolBefore).to.equal(expectedProtocol);
      expect(await rewards.pending(padOwner.address) - padBefore).to.equal(expectedPad);
      expect(await rewards.totalPending()).to.equal(
        await ethers.provider.getBalance(await rewards.getAddress()),
      );
    });
  });
});
