// SPDX-License-Identifier: GPL-3.0-only
// The two addresses Spotify's sign-in passes through. Both are opened in a browser on the computer that
// runs the server, because Spotify only returns to the literal 127.0.0.1.

const MAX_PARAM = 2048;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);
const isLoopback = (address) =>
    address === '::1' || address === '127.0.0.1' || String(address).startsWith('::ffff:127.');

/** True for a request from this machine, by its loopback address or by its own LAN address. */
function fromThisComputer(socket) {
    return isLoopback(socket.remoteAddress) || socket.remoteAddress === socket.localAddress;
}

function page(title, message, ok) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
:root {
    --bg: #f3f6f9; --surface: #fff; --edge: #ccd5de; --text: #263340; --dim: #647383;
    --mark: ${ok ? '#2e9e5e' : '#c8423d'};
}
@media (prefers-color-scheme: dark) {
    :root {
        --bg: #0d141c; --surface: #141d27; --edge: #2c3d4e; --text: #e3ebf2; --dim: #8ea1b3;
        --mark: ${ok ? '#4cbf7e' : '#ef7772'};
    }
}
* { box-sizing: border-box; }
body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif;
}
main {
    max-width: 440px; padding: 24px; border: 1px solid var(--edge); border-top: 4px solid var(--mark);
    border-radius: 14px; background: var(--surface);
}
h1 { margin: 0 0 8px; font-size: 20px; }
p { margin: 0; color: var(--dim); }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</main>
</body>
</html>
`;
}

function send(res, status, title, message, ok = false) {
    const body = page(title, message, ok);
    res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
}

/** Handles GET /api/spotify/login (sends the browser to Spotify) and /api/spotify/callback (where it returns). */
async function handleSpotifyAuth(req, res, url, registry) {
    if (req.method !== 'GET') return send(res, 405, 'Not allowed', 'Open this address in a browser.');
    if (!fromThisComputer(req.socket)) {
        return send(res, 403, 'Open WiiJukebox on this computer',
            'Spotify only sends you back to 127.0.0.1, so sign in from a browser on the computer ' +
            'that runs WiiJukebox.');
    }
    const source = registry.get('spotify');
    if (url.pathname.endsWith('/login')) {
        try {
            const location = source.beginLogin();
            res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
            return res.end();
        } catch (err) {
            return send(res, 400, 'Spotify sign-in could not start', err.message);
        }
    }
    const param = (name) => (url.searchParams.get(name) || '').slice(0, MAX_PARAM) || undefined;
    try {
        await source.completeLogin({ code: param('code'), state: param('state'), error: param('error') });
        return send(res, 200, 'Spotify is connected', 'You can close this tab and go back to WiiJukebox.', true);
    } catch (err) {
        return send(res, 400, 'Spotify did not connect', err.message);
    }
}

module.exports = { handleSpotifyAuth, fromThisComputer, isLoopback };
