const { expect } = require('chai');
const { ethers } = require('hardhat');
const path = require('path');
const { pathToFileURL } = require('url');

/**
 * The browser app encodes its own calldata (no ethers in the browser, no build step). If that
 * codec is wrong, users sign transactions that revert or — worse — do something other than what
 * the UI said. So every encoding is checked against ethers' reference encoder here.
 */
describe('web/chain.js ABI codec', () => {
  let chain;

  before(async () => {
    const url = pathToFileURL(path.join(__dirname, '..', '..', 'web', 'chain.js')).href;
    chain = await import(url);
  });

  const factoryIface = new ethers.Interface([
    'function createLaunchpad(string name, string metadataURI, uint8 preset, uint8 launchPolicy)',
  ]);
  const padIface = new ethers.Interface([
    'function launchToken(string tokenName, string symbol, uint256 wholeTokenSupply)',
  ]);

  describe('encodeCall', () => {
    const padCases = [
      ['simple', 'My Pad', 'ipfs://meta', 0, 1],
      ['empty metadata', 'My Pad', '', 1, 0],
      ['exactly 32 bytes', 'x'.repeat(32), 'y'.repeat(32), 0, 0],
      ['33 bytes (crosses a word)', 'x'.repeat(33), 'y'.repeat(33), 1, 1],
      ['max length name', 'x'.repeat(64), 'y'.repeat(256), 0, 1],
      ['unicode', 'Ünïcødé Pad 🚀', 'ipfs://ünïcødé', 0, 1],
      ['single char', 'a', 'b', 0, 0],
    ];

    for (const [label, name, uri, preset, policy] of padCases) {
      it(`matches ethers for createLaunchpad — ${label}`, () => {
        const mine = chain.encodeCall('createLaunchpad(string,string,uint8,uint8)', [
          { type: 'string', value: name },
          { type: 'string', value: uri },
          { type: 'uint', value: preset },
          { type: 'uint', value: policy },
        ]);
        const reference = factoryIface.encodeFunctionData('createLaunchpad', [name, uri, preset, policy]);
        expect(mine).to.equal(reference);
      });
    }

    const tokenCases = [
      ['typical', 'Alpha', 'ALPHA', 1000000n],
      ['max supply', 'Max', 'MAX', 1000000000000n],
      ['one wei-token', 'One', 'O', 1n],
      ['unicode name', 'Tökén 🎯', 'TKN', 42n],
    ];

    for (const [label, name, symbol, supply] of tokenCases) {
      it(`matches ethers for launchToken — ${label}`, () => {
        const mine = chain.encodeCall('launchToken(string,string,uint256)', [
          { type: 'string', value: name },
          { type: 'string', value: symbol },
          { type: 'uint', value: supply },
        ]);
        const reference = padIface.encodeFunctionData('launchToken', [name, symbol, supply]);
        expect(mine).to.equal(reference);
      });
    }

    it('encodes address arguments the same way ethers does', () => {
      const iface = new ethers.Interface(['function balanceOf(address account)']);
      const account = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
      expect(chain.encodeCall('balanceOf(address)', [{ type: 'address', value: account }]))
        .to.equal(iface.encodeFunctionData('balanceOf', [account]));
    });

    it('encodes two uint arguments the same way ethers does', () => {
      const iface = new ethers.Interface(['function tokensPage(uint256 offset, uint256 limit)']);
      expect(chain.encodeCall('tokensPage(uint256,uint256)', [
        { type: 'uint', value: 3 },
        { type: 'uint', value: 50 },
      ])).to.equal(iface.encodeFunctionData('tokensPage', [3, 50]));
    });

    it('rejects an unknown signature rather than sending garbage', () => {
      expect(() => chain.encodeCall('notARealFunction()', [])).to.throw(/unknown signature/);
    });

    it('rejects a malformed address rather than sending garbage', () => {
      expect(() => chain.encodeCall('balanceOf(address)', [{ type: 'address', value: 'nope' }]))
        .to.throw(/bad address/);
    });
  });

  describe('decoders', () => {
    it('decodes a string return value', () => {
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['NVDA Floor']);
      expect(chain.decodeString(encoded)).to.equal('NVDA Floor');
    });

    it('decodes a unicode string return value', () => {
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['Ünïcødé 🚀']);
      expect(chain.decodeString(encoded)).to.equal('Ünïcødé 🚀');
    });

    it('decodes an empty string', () => {
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['']);
      expect(chain.decodeString(encoded)).to.equal('');
    });

    it('decodes a long string that spans several words', () => {
      const long = 'z'.repeat(200);
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['string'], [long]);
      expect(chain.decodeString(encoded)).to.equal(long);
    });

    it('decodes an address array', () => {
      const addresses = [
        '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      ];
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [addresses]);
      expect(chain.decodeAddressArray(encoded)).to.deep.equal(addresses);
    });

    it('decodes an empty address array', () => {
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [[]]);
      expect(chain.decodeAddressArray(encoded)).to.deep.equal([]);
    });

    it('decodes a uint', () => {
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [12345678901234567890n]);
      expect(chain.decodeUint(encoded)).to.equal(12345678901234567890n);
    });

    it('returns safe defaults for empty return data instead of throwing', () => {
      expect(chain.decodeString('0x')).to.equal('');
      expect(chain.decodeAddressArray('0x')).to.deep.equal([]);
      expect(chain.decodeUint('0x')).to.equal(0n);
    });
  });

  describe('addressFromLog', () => {
    it('reads the indexed launchpad address out of a real receipt', async () => {
      const [, padOwner, protocol, reserve] = await ethers.getSigners();
      const factory = await (await ethers.getContractFactory('LaunchpadFactory'))
        .deploy(protocol.address, reserve.address);
      const receipt = await (await factory.connect(padOwner)
        .createLaunchpad('Log Pad', '', 0, 1)).wait();

      const topic = chain.ABI.TOPICS['LaunchpadCreated(address,address,address,uint8,uint8,string,string)'];
      const padAddress = chain.addressFromLog(receipt, topic, 1);
      const ownerAddress = chain.addressFromLog(receipt, topic, 2);

      const expected = await factory.launchpads(0);
      expect(padAddress.toLowerCase()).to.equal(expected.toLowerCase());
      expect(ownerAddress.toLowerCase()).to.equal(padOwner.address.toLowerCase());
    });

    it('reads the indexed token address and creator out of a real receipt', async () => {
      const [, padOwner, protocol, reserve, stranger] = await ethers.getSigners();
      const factory = await (await ethers.getContractFactory('LaunchpadFactory'))
        .deploy(protocol.address, reserve.address);
      await (await factory.connect(padOwner).createLaunchpad('Open', '', 0, 1)).wait();
      const pad = await ethers.getContractAt('Launchpad', await factory.launchpads(0));

      const receipt = await (await pad.connect(stranger).launchToken('T', 'T', 1n)).wait();
      const topic = chain.ABI.TOPICS['TokenLaunched(address,address,string,string,uint256)'];

      expect(chain.addressFromLog(receipt, topic, 1).toLowerCase())
        .to.equal((await pad.tokens(0)).toLowerCase());
      expect(chain.addressFromLog(receipt, topic, 2).toLowerCase())
        .to.equal(stranger.address.toLowerCase());
    });

    it('returns null when the log is absent rather than a wrong address', () => {
      expect(chain.addressFromLog({ logs: [] }, '0x' + '11'.repeat(32))).to.equal(null);
    });
  });

  describe('display helpers', () => {
    it('formats token units without floating point error', () => {
      expect(chain.formatUnits(10n ** 18n)).to.equal('1');
      expect(chain.formatUnits(1500000000000000000n)).to.equal('1.5');
      expect(chain.formatUnits(10n ** 27n)).to.equal('1000000000');
      expect(chain.formatUnits(1n)).to.equal('0.000000000000000001');
      expect(chain.formatUnits(0n)).to.equal('0');
    });

    it('never invents an explorer URL for an unknown chain', () => {
      expect(chain.explorerUrl('tx', '0xabc', 31337)).to.equal(null);
      expect(chain.explorerUrl('tx', '0xabc', 46630))
        .to.equal('https://explorer.testnet.chain.robinhood.com/tx/0xabc');
    });

    it('labels the Standard preset as an alpha default', () => {
      expect(chain.presetLabel(chain.PRESET.STANDARD)).to.match(/alpha default/i);
    });

    it('labels an open policy so users know anyone can launch', () => {
      expect(chain.policyLabel(chain.POLICY.OPEN)).to.match(/anyone/i);
      expect(chain.policyLabel(chain.POLICY.OWNER_ONLY)).to.match(/owner/i);
    });
  });
});
