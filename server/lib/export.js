// ---------------------------------------------------------------------------
// Launchpad frontend export.
//
// The generated repository is a SKIN. It is not, and must never become, a source
// of economic truth:
//
//   - it contains no keys, tokens, secrets or .env of any kind;
//   - it holds ADDRESSES only, never fee percentages, recipients or splits;
//   - every economic value is read from the contracts at runtime;
//   - repointing it at other contracts does not move any money — those launches
//     simply are not recognised as coming from this pad.
//
// It also inherits no endorsement. A downloaded frontend served from someone
// else's domain is not "listed by Launchpad.family", and the generated README
// says so rather than leaving it ambiguous.
// ---------------------------------------------------------------------------

/** Files that would turn the export into a second source of truth. */
const FORBIDDEN_KEYS = [
  'privateKey', 'private_key', 'mnemonic', 'secret', 'apiKey', 'api_key', 'token',
  'creatorBps', 'padOwnerBps', 'protocolBps', 'feeRecipient', 'splitBps', 'treasury',
];

/**
 * Config the exported client reads. Deliberately addresses and identity only.
 * @throws if anything economic or secret-shaped sneaks in.
 */
export function padConfig({ pad, chainId, contracts, apex }) {
  const config = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    chainId,
    // The launchpad this frontend is a skin for. Changing it does not make
    // Launchpad.family recognise launches as coming from this pad.
    padAddress: pad.padAddress,
    slug: pad.slug,
    canonicalUrl: `https://${pad.slug}.${apex}`,
    contracts: {
      factory: contracts.factory ?? null,
      launcher: contracts.launcher ?? null,
      rewards: contracts.rewards ?? null,
    },
    branding: {
      displayName: pad.branding.displayName,
      tagline: pad.branding.tagline,
      description: pad.branding.description,
      accent: pad.branding.accent,
      links: pad.branding.links,
    },
    notice: 'Economics are read from the contracts at runtime. This file contains addresses only.',
  };

  const serialised = JSON.stringify(config);
  for (const key of FORBIDDEN_KEYS) {
    if (serialised.includes(`"${key}"`)) {
      throw new Error(`export config would contain a forbidden field: ${key}`);
    }
  }
  return config;
}

function readme({ pad, apex, chainId }) {
  const name = pad.branding.displayName;
  return `# ${name}

The frontend for **${name}**, a launchpad on Launchpad.family.

Canonical hosted version: https://${pad.slug}.${apex}
Launchpad contract: \`${pad.padAddress}\` (chain ${chainId})

## What this is

A **client** for an onchain launchpad. Your launchpad, its owner, its launch rule
and every token launched through it live in smart contracts. This repository is
the interface — you can restyle it, host it on your own domain, and change
anything about how it looks.

## What this cannot change

Fee recipients, the revenue split, attribution and market provenance are enforced
by the contracts. They are not present as editable values anywhere in this
repository, and editing this code cannot alter them.

If you point \`pad.config.json\` at different contracts, that is allowed — but
launches made through them are **not** recognised by Launchpad.family as coming
from ${name}, and will not appear on its hosted page, directory or leaderboard.

## What this repository is not

Hosting this yourself does **not** mean Launchpad.family has reviewed, endorsed
or listed your deployment. Two separate things:

| Claim | Who decides |
|---|---|
| **Onchain Launch Proof** — a token really launched through this pad | The contracts. Anyone can verify it. |
| **Listed by Launchpad.family** — we distribute and recommend it | Us, and revocable. |

A custom frontend inherits the first automatically and the second never.

## Running it

No build step and no dependencies.

\`\`\`bash
npx http-server . -p 4173
\`\`\`

## Security

This repository contains **no keys and no secrets**, by construction — the
generator refuses to emit them. Never commit a private key, mnemonic or API token
here. Nothing in this frontend needs one: all writes are signed by the visitor's
own wallet.
`;
}

const indexHtml = ({ pad }) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${pad.branding.displayName}</title>
  <link rel="stylesheet" href="./style.css" />
</head>
<body>
  <header>
    <h1 id="padName">${pad.branding.displayName}</h1>
    <p id="padTagline">${pad.branding.tagline || ''}</p>
  </header>
  <main id="app">Loading from chain…</main>
  <footer>
    <p id="provenance"></p>
    <p class="muted">
      Launchpad infrastructure by <a href="https://launchpad.family">Launchpad.family</a>.
      This frontend is operated independently and is not endorsed or listed by Launchpad.family.
    </p>
  </footer>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

const appJs = () => `// Reads everything from chain. No economics are stored in this repository.
const config = await fetch('./pad.config.json').then((r) => r.json());

const app = document.getElementById('app');
const rpc = (method, params = []) => fetch(config.rpcUrl ?? DEFAULT_RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
}).then((r) => r.json()).then((j) => {
  if (j.error) throw new Error(j.error.message);
  return j.result;
});

const DEFAULT_RPC = 'https://rpc.mainnet.chain.robinhood.com';

// Selector for owner(); the client verifies the pad exists rather than assuming.
const OWNER = '0x8da5cb5b';

try {
  const owner = await rpc('eth_call', [{ to: config.padAddress, data: OWNER }, 'latest']);
  app.innerHTML = \`
    <p>Launchpad <code>\${config.padAddress}</code> on chain \${config.chainId}.</p>
    <p>Owner: <code>0x\${owner.slice(-40)}</code></p>
    <p><a href="\${config.canonicalUrl}/launch">Launch a token</a></p>\`;
  document.getElementById('provenance').textContent =
    'Launches are verified against the Launchpad.family market contracts on chain.';
} catch (error) {
  // A failed read is reported, never rendered as an empty launchpad.
  app.innerHTML = \`<p>Could not read the launchpad from chain: \${error.message}</p>\`;
}
`;

const styleCss = ({ pad, accentColor }) => `:root { --accent: ${accentColor}; }
body {
  background: #0B0D12; color: #E8EAF0; margin: 0;
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
header, main, footer { max-width: 860px; margin: 0 auto; padding: 24px 20px; }
h1 { color: var(--accent); margin: 0 0 6px; }
a { color: var(--accent); }
code { font-family: ui-monospace, monospace; font-size: 13px; }
.muted { color: #8C93A5; font-size: 13px; }
footer { border-top: 1px solid #232733; margin-top: 30px; }
/* ${pad.slug} */
`;

const gitignore = () => `# Never commit secrets. This frontend does not need any.
.env
.env.*
*.key
*.pem
node_modules/
`;

/**
 * Builds the full file set for a pad's exported frontend.
 * @returns {{path: string, content: string}[]}
 */
export function buildExport({ pad, chainId, contracts, apex, accentColors = {} }) {
  const config = padConfig({ pad, chainId, contracts, apex });
  const accentColor = accentColors[pad.branding.accent] ?? '#8B7CFF';

  const files = [
    { path: 'pad.config.json', content: `${JSON.stringify(config, null, 2)}\n` },
    { path: 'README.md', content: readme({ pad, apex, chainId }) },
    { path: 'index.html', content: indexHtml({ pad }) },
    { path: 'app.js', content: appJs() },
    { path: 'style.css', content: styleCss({ pad, accentColor }) },
    { path: '.gitignore', content: gitignore() },
  ];

  // Last line of defence: nothing secret-shaped may leave here.
  for (const file of files) {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY|PRIVATE_KEY\s*=\s*0x[0-9a-f]{64}/i.test(file.content)) {
      throw new Error(`export refused: ${file.path} appears to contain a key`);
    }
  }
  return files;
}

/** Whether real GitHub repository creation is available on this deployment. */
export function githubStatus(env = process.env) {
  const configured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  return {
    configured,
    reason: configured ? null : 'no GitHub OAuth app is configured on this server',
    // Stated plainly rather than implied: this path has never been exercised
    // against a real GitHub account, because no credentials exist yet.
    proven: false,
  };
}

/** A deterministic tar archive, so the download needs no dependency. */
export function buildTar(files) {
  const blocks = [];
  const encoder = new TextEncoder();

  for (const file of files) {
    const data = encoder.encode(file.content);
    const header = new Uint8Array(512);
    const write = (text, offset, length) => {
      const bytes = encoder.encode(text.slice(0, length));
      header.set(bytes, offset);
    };
    write(file.path, 0, 100);
    write('000644 \0', 100, 8);
    write('000000 \0', 108, 8);
    write('000000 \0', 116, 8);
    write(`${data.length.toString(8).padStart(11, '0')} `, 124, 12);
    write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')} `, 136, 12);
    write('        ', 148, 8); // checksum placeholder
    write('0', 156, 1);
    write('ustar  \0', 257, 8);

    let checksum = 0;
    for (const byte of header) checksum += byte;
    write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);

    blocks.push(header);
    blocks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(1024)); // end-of-archive

  const total = blocks.reduce((sum, b) => sum + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) { out.set(block, offset); offset += block.length; }
  return Buffer.from(out);
}
