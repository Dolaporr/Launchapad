const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { PRESET, deployFactory, createPad } = require('./helpers');

const ONE = ethers.parseEther('1');

describe('FeeRouter', () => {
  async function standardRouter() {
    const base = await deployFactory();
    const { router } = await createPad(base.factory, base.padOwner, 'Std', '', PRESET.STANDARD);
    return { ...base, router };
  }

  async function nvdaRouter() {
    const base = await deployFactory();
    const { router } = await createPad(base.factory, base.padOwner, 'NVDA', '', PRESET.NVDA);
    return { ...base, router };
  }

  describe('construction', () => {
    it('rejects zero pad owner or treasury', async () => {
      const Router = await ethers.getContractFactory('FeeRouter');
      const [a] = await ethers.getSigners();
      await expect(Router.deploy(ethers.ZeroAddress, a.address, a.address, PRESET.STANDARD))
        .to.be.revertedWithCustomError(Router, 'ZeroAddress');
      await expect(Router.deploy(a.address, ethers.ZeroAddress, a.address, PRESET.STANDARD))
        .to.be.revertedWithCustomError(Router, 'ZeroAddress');
    });

    it('requires a reserve receiver only for the NVDA preset', async () => {
      const Router = await ethers.getContractFactory('FeeRouter');
      const [a] = await ethers.getSigners();
      await expect(Router.deploy(a.address, a.address, ethers.ZeroAddress, PRESET.NVDA))
        .to.be.revertedWithCustomError(Router, 'ZeroAddress');
      await expect(Router.deploy(a.address, a.address, ethers.ZeroAddress, PRESET.STANDARD))
        .to.not.be.reverted;
    });

    it('exposes no owner, admin, pause or setter', async () => {
      const { router } = await loadFixture(standardRouter);
      const names = router.interface.fragments
        .filter((f) => f.type === 'function')
        .map((f) => f.name.toLowerCase());
      for (const forbidden of ['owner', 'transferownership', 'pause', 'upgradeto', 'setpreset', 'initialize']) {
        expect(names, `router should not expose ${forbidden}`).to.not.include(forbidden);
      }
      expect(names.filter((n) => n.startsWith('set'))).to.deep.equal([]);
    });
  });

  describe('Standard preset split (0.50% owner / 0.10% protocol of notional)', () => {
    it('credits exactly 5/6 to the owner and 1/6 to the protocol', async () => {
      const { router, padOwner, protocol, stranger } = await loadFixture(standardRouter);
      const gross = ethers.parseEther('6');

      await expect(router.connect(stranger).route({ value: gross }))
        .to.emit(router, 'FeeRouted')
        .withArgs(gross, ethers.parseEther('5'), ONE, 0n);

      expect(await router.pending(padOwner.address)).to.equal(ethers.parseEther('5'));
      expect(await router.pending(protocol.address)).to.equal(ONE);
      expect(await router.totalPending()).to.equal(gross);
      expect(await router.totalOwnerAccrued()).to.equal(ethers.parseEther('5'));
      expect(await router.totalProtocolAccrued()).to.equal(ONE);
      expect(await router.totalReserveAccrued()).to.equal(0n);
      expect(await router.totalRoutedGross()).to.equal(gross);
    });

    it('gives rounding dust to the pad owner and never loses a wei', async () => {
      const { router, padOwner, protocol, stranger } = await loadFixture(standardRouter);
      // 5 wei / 6 == 0 for the protocol, so the owner takes all 5.
      await router.connect(stranger).route({ value: 5n });
      expect(await router.pending(protocol.address)).to.equal(0n);
      expect(await router.pending(padOwner.address)).to.equal(5n);

      await router.connect(stranger).route({ value: 7n });
      expect(await router.pending(protocol.address)).to.equal(1n);
      expect(await router.pending(padOwner.address)).to.equal(11n);
      // Conservation: every wei routed is credited to somebody.
      expect(await router.totalPending()).to.equal(12n);
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(12n);
    });
  });

  describe('NVDA Reserve preset split (0.80% reserve / 0.20% execution of notional)', () => {
    it('credits exactly 80% to the reserve receiver and 20% to execution', async () => {
      const { router, padOwner, protocol, reserveReceiver, stranger } = await loadFixture(nvdaRouter);
      const gross = ethers.parseEther('10');

      await expect(router.connect(stranger).route({ value: gross }))
        .to.emit(router, 'FeeRouted')
        .withArgs(gross, 0n, ethers.parseEther('2'), ethers.parseEther('8'));

      expect(await router.pending(reserveReceiver.address)).to.equal(ethers.parseEther('8'));
      expect(await router.pending(protocol.address)).to.equal(ethers.parseEther('2'));
      // The headline promise: no team/creator allocation out of the reserve fee.
      expect(await router.pending(padOwner.address)).to.equal(0n);
      expect(await router.totalOwnerAccrued()).to.equal(0n);
    });

    it('gives rounding dust to the execution leg and never loses a wei', async () => {
      const { router, protocol, reserveReceiver, stranger } = await loadFixture(nvdaRouter);
      await router.connect(stranger).route({ value: 9n });
      expect(await router.pending(reserveReceiver.address)).to.equal(7n); // floor(9 * 0.8)
      expect(await router.pending(protocol.address)).to.equal(2n);
      expect(await router.totalPending()).to.equal(9n);
    });

    it('keeps the 80/20 ratio across many random amounts with no leakage', async () => {
      const { router, protocol, reserveReceiver, stranger } = await loadFixture(nvdaRouter);
      let gross = 0n;
      for (let i = 1; i <= 25; i += 1) {
        const amount = BigInt(i) * 7919n + 1n;
        await router.connect(stranger).route({ value: amount });
        gross += amount;
      }
      const reserve = await router.pending(reserveReceiver.address);
      const exec = await router.pending(protocol.address);
      expect(reserve + exec).to.equal(gross);
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(gross);
      // Truncation can only ever favour execution, and only by <1 wei per route.
      expect(reserve).to.be.at.most((gross * 8000n) / 10000n);
      expect((gross * 8000n) / 10000n - reserve).to.be.at.most(25n);
    });

    it('advertises the reserve share as an immutable constant', async () => {
      const { router } = await loadFixture(nvdaRouter);
      expect(await router.NVDA_RESERVE_BPS()).to.equal(8000n);
      expect(await router.preset()).to.equal(BigInt(PRESET.NVDA));
    });
  });

  describe('routing entry points', () => {
    it('routes plain native transfers through receive()', async () => {
      const { router, padOwner, stranger } = await loadFixture(standardRouter);
      await stranger.sendTransaction({ to: await router.getAddress(), value: ethers.parseEther('6') });
      expect(await router.pending(padOwner.address)).to.equal(ethers.parseEther('5'));
    });

    it('rejects zero-value routes', async () => {
      const { router, stranger } = await loadFixture(standardRouter);
      await expect(router.connect(stranger).route({ value: 0 }))
        .to.be.revertedWithCustomError(router, 'ZeroAmount');
      await expect(stranger.sendTransaction({ to: await router.getAddress(), value: 0 }))
        .to.be.revertedWithCustomError(router, 'ZeroAmount');
    });
  });

  describe('withdrawals', () => {
    it('lets a beneficiary pull its own balance', async () => {
      const { router, padOwner, stranger } = await loadFixture(standardRouter);
      await router.connect(stranger).route({ value: ethers.parseEther('6') });

      const before = await ethers.provider.getBalance(padOwner.address);
      const receipt = await (await router.connect(padOwner).withdraw()).wait();
      const gas = receipt.gasUsed * receipt.gasPrice;
      expect(await ethers.provider.getBalance(padOwner.address))
        .to.equal(before + ethers.parseEther('5') - gas);
      await expect(receipt).to.emit(router, 'FeeWithdrawn')
        .withArgs(padOwner.address, ethers.parseEther('5'), padOwner.address);

      expect(await router.pending(padOwner.address)).to.equal(0n);
      expect(await router.totalPending()).to.equal(ONE);
    });

    it('lets anyone push a beneficiary its balance without gaining discretion', async () => {
      const { router, padOwner, stranger } = await loadFixture(standardRouter);
      await router.connect(stranger).route({ value: ethers.parseEther('6') });

      await expect(router.connect(stranger).withdrawFor(padOwner.address))
        .to.changeEtherBalances([padOwner, stranger], [ethers.parseEther('5'), 0n]);
    });

    it('reverts when there is nothing pending', async () => {
      const { router, stranger, padOwner } = await loadFixture(standardRouter);
      await expect(router.connect(stranger).withdraw())
        .to.be.revertedWithCustomError(router, 'NothingPending');
      await expect(router.connect(stranger).withdrawFor(padOwner.address))
        .to.be.revertedWithCustomError(router, 'NothingPending');
    });

    it('cannot be drained twice', async () => {
      const { router, padOwner, stranger } = await loadFixture(standardRouter);
      await router.connect(stranger).route({ value: ethers.parseEther('6') });
      await router.connect(padOwner).withdraw();
      await expect(router.connect(padOwner).withdraw())
        .to.be.revertedWithCustomError(router, 'NothingPending');
    });
  });

  describe('denial-of-service resistance (the bug that made the NVDA preset unusable)', () => {
    it('a reserve receiver that rejects native currency cannot block fee routing', async () => {
      const [, padOwner, protocol] = await ethers.getSigners();
      const rejecting = await (await ethers.getContractFactory('RejectingBeneficiary')).deploy();
      const factory = await (await ethers.getContractFactory('LaunchpadFactory'))
        .deploy(protocol.address, await rejecting.getAddress());
      const { router } = await createPad(factory, padOwner, 'NVDA', '', PRESET.NVDA);

      // Routing still succeeds: the reserve leg accrues instead of being pushed.
      await expect(router.route({ value: ethers.parseEther('10') })).to.not.be.reverted;
      expect(await router.pending(await rejecting.getAddress())).to.equal(ethers.parseEther('8'));

      // The healthy beneficiary is unaffected and can still be paid.
      await expect(router.withdrawFor(protocol.address))
        .to.changeEtherBalance(protocol, ethers.parseEther('2'));

      // Only the broken beneficiary's own withdrawal fails, and its funds stay credited.
      await expect(router.withdrawFor(await rejecting.getAddress()))
        .to.be.revertedWithCustomError(router, 'TransferFailed');
      expect(await router.pending(await rejecting.getAddress())).to.equal(ethers.parseEther('8'));
    });

    it('a ReserveVault wired as reserve receiver no longer bricks the whole preset', async () => {
      const [deployer, padOwner, protocol] = await ethers.getSigners();
      const mockNvda = await (await ethers.getContractFactory('MockScaledUIToken'))
        .deploy(deployer.address, ethers.parseEther('1000'), ethers.parseEther('1'));
      const vault = await (await ethers.getContractFactory('ReserveVault'))
        .deploy(deployer.address, await mockNvda.getAddress());
      const factory = await (await ethers.getContractFactory('LaunchpadFactory'))
        .deploy(protocol.address, await vault.getAddress());
      const { router } = await createPad(factory, padOwner, 'NVDA', '', PRESET.NVDA);

      // Before the fix this reverted with "eth transfer failed" and no fee could ever be routed.
      await expect(router.route({ value: ethers.parseEther('10') })).to.not.be.reverted;
      expect(await router.pending(await vault.getAddress())).to.equal(ethers.parseEther('8'));
    });

    it('holds checks-effects-interactions against a re-entering beneficiary', async () => {
      const [, , protocol] = await ethers.getSigners();
      const attacker = await (await ethers.getContractFactory('ReentrantBeneficiary')).deploy();
      const Router = await ethers.getContractFactory('FeeRouter');
      const router = await Router.deploy(
        await attacker.getAddress(), protocol.address, ethers.ZeroAddress, PRESET.STANDARD,
      );
      await attacker.setRouter(await router.getAddress());

      await router.route({ value: ethers.parseEther('6') });
      await attacker.withdraw();

      expect(await attacker.reentryAttempts()).to.equal(1n);
      expect(await attacker.reentryReverted()).to.equal(true);
      expect(await router.pending(await attacker.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(await attacker.getAddress())).to.equal(ethers.parseEther('5'));
      // The protocol leg is untouched and the router still owes exactly that much.
      expect(await router.totalPending()).to.equal(ONE);
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(ONE);
    });
  });

  describe('unaccounted balance', () => {
    it('is zero while accounting is exact', async () => {
      const { router, stranger } = await loadFixture(standardRouter);
      await router.connect(stranger).route({ value: ethers.parseEther('6') });
      expect(await router.unaccountedBalance()).to.equal(0n);
      await expect(router.connect(stranger).sweepUnaccounted())
        .to.be.revertedWithCustomError(router, 'ZeroAmount');
    });

    it('can only ever be swept to the protocol treasury', async () => {
      const { router, protocol, stranger } = await loadFixture(standardRouter);
      // Force native in without touching the router's accounting.
      await ethers.provider.send('hardhat_setBalance', [
        await router.getAddress(), '0x' + ethers.parseEther('3').toString(16),
      ]);
      expect(await router.unaccountedBalance()).to.equal(ethers.parseEther('3'));

      await expect(router.connect(stranger).sweepUnaccounted())
        .to.changeEtherBalances([protocol, stranger], [ethers.parseEther('3'), 0n]);
      expect(await router.unaccountedBalance()).to.equal(0n);
    });

    it('never reports pending fees as unaccounted', async () => {
      const { router, stranger } = await loadFixture(standardRouter);
      await router.connect(stranger).route({ value: ethers.parseEther('6') });
      await ethers.provider.send('hardhat_setBalance', [
        await router.getAddress(), '0x' + ethers.parseEther('7').toString(16),
      ]);
      expect(await router.unaccountedBalance()).to.equal(ONE);
    });
  });
});
