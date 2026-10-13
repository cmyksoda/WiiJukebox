// SPDX-License-Identifier: GPL-3.0-only
// Spotify Web API access: sign-in with Authorization Code + PKCE, token refresh and the few endpoints
// WiiJukebox needs. The refresh token stays inside this object and the server's config, and every
// message thrown from here is safe to show.

const crypto = require('node:crypto');

const ACCOUNTS_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';
const CALLBACK_PATH = '/api/spotify/callback';
const SCOPES = [
    'user-library-read',
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-read-playback-state',
    'user-modify-playback-state',
];

const REQUEST_TIMEOUT_MS = 15000;
const EXPIRY_MARGIN_MS = 60 * 1000;
// A 429 that asks for a short wait is waited out once; a longer one is reported instead.
const MAX_INLINE_RETRY_S = 5;
const DEFAULT_RETRY_S = 5;

const MESSAGES = {
    'no-client-id': 'Add your Spotify Client ID in the Spotify settings.',
    'not-connected': 'Spotify is not connected. Use Connect Spotify account in the Spotify settings.',
    reconnect: 'Spotify no longer accepts the saved sign-in. Use Reconnect Spotify in the Spotify settings.',
    premium: 'Spotify Premium is required to control playback.',
    'not-allowlisted': 'Spotify refused this account. In development mode the account must be added under ' +
        'User Management in your app at developer.spotify.com, and the app owner needs Premium.',
    'no-device': 'Spotify cannot find the receiver. Start it and check it is signed in to this Spotify account.',
};

class SpotifyError extends Error {
    /**
     * @param {string} kind  a key of MESSAGES, or 'forbidden', 'restricted', 'rate-limited', 'not-found',
     *   'network', 'api', 'login', 'timeout' or 'device-not-found'
     */
    constructor(kind, detail = '', extra = {}) {
        super(MESSAGES[kind] || detail);
        this.name = 'SpotifyError';
        this.kind = kind;
        Object.assign(this, extra);
    }
}

/** 43 to 128 URL-safe characters, as the PKCE flow asks. */
function pkcePair() {
    const verifier = crypto.randomBytes(64).toString('base64url');
    return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeUrl({ clientId, redirectUri, state, challenge, base = ACCOUNTS_BASE }) {
    const url = new URL('/authorize', base);
    url.search = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        state,
        scope: SCOPES.join(' '),
        code_challenge_method: 'S256',
        code_challenge: challenge,
    }).toString();
    return url.toString();
}

/** Spotify only accepts a loopback redirect written as the literal 127.0.0.1. */
function redirectUriFor(port) {
    return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}${CALLBACK_PATH}` : null;
}

const rateLimited = (seconds) =>
    new SpotifyError('rate-limited', `Spotify is rate limiting this app; try again in ${seconds} s.`, { retryAfter: seconds });

class SpotifyApi {
    constructor({
        clientId = '', refreshToken = null, onRefreshToken = () => {}, onRevoked = () => {},
        fetchImpl = fetch, accountsBase = ACCOUNTS_BASE, apiBase = API_BASE, now = Date.now, sleep,
    } = {}) {
        this.clientId = clientId;
        this.refreshToken = refreshToken;
        this._onRefreshToken = onRefreshToken;
        this._onRevoked = onRevoked;
        this._fetch = fetchImpl;
        this._accounts = accountsBase;
        this._api = apiBase;
        this._now = now;
        this._sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this._access = null;
        this._expires = 0;
        this._refreshing = null;
        this._blockedUntil = 0;
    }

    get hasToken() {
        return Boolean(this.refreshToken);
    }

    forget() {
        this.refreshToken = null;
        this._access = null;
        this._expires = 0;
    }

    /** Text that came from outside, with anything shaped like a token or one of ours removed. */
    clean(text) {
        let out = String(text ?? '')
            .replace(/Bearer\s+\S+/gi, 'Bearer …')
            .replace(/[A-Za-z0-9._~+/-]{40,}/g, '…');
        for (const secret of [this.refreshToken, this._access]) {
            if (secret) out = out.replaceAll(secret, '…');
        }
        return out.slice(0, 200);
    }

    async exchange(code, verifier, redirectUri) {
        this._requireClient();
        const body = await this._token({
            grant_type: 'authorization_code', code, redirect_uri: redirectUri,
            client_id: this.clientId, code_verifier: verifier,
        });
        if (!body.refresh_token) throw new SpotifyError('login', 'Spotify sent no refresh token.');
        this.refreshToken = body.refresh_token;
        return body.refresh_token;
    }

    get(path, query) {
        return this.request('GET', path, { query });
    }

    /** Calls the Web API. A 401 refreshes the token once; a 429 backs off and is reported with its wait. */
    async request(method, path, { query, body, attempt = 0 } = {}) {
        const waiting = Math.ceil((this._blockedUntil - this._now()) / 1000);
        if (waiting > 0) throw rateLimited(waiting);

        const url = new URL(`${this._api}${path}`);
        for (const [key, value] of Object.entries(query || {})) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }
        const headers = { Authorization: `Bearer ${await this._accessToken()}`, Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await this._send(url, {
            method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        });

        if (response.status === 401 && attempt === 0) {
            this._access = null;
            return this.request(method, path, { query, body, attempt: 1 });
        }
        if (response.status === 429) {
            const seconds = Math.max(1, Number(response.headers.get('retry-after')) || DEFAULT_RETRY_S);
            this._blockedUntil = this._now() + seconds * 1000;
            if (attempt === 0 && seconds <= MAX_INLINE_RETRY_S) {
                // A little over the wait, so the retry never lands inside it.
                await this._sleep(seconds * 1000 + 50);
                return this.request(method, path, { query, body, attempt: 1 });
            }
            throw rateLimited(seconds);
        }
        if (response.ok) {
            const text = await response.text();
            return text ? JSON.parse(text) : null;
        }
        throw await this._failure(response);
    }

    // --- endpoints ---------------------------------------------------------------

    me() {
        return this.get('/me');
    }

    async devices() {
        return (await this.get('/me/player/devices'))?.devices || [];
    }

    playerState() {
        return this.get('/me/player', { additional_types: 'track,episode' });
    }

    startPlayback(deviceId, body = {}) {
        return this.request('PUT', '/me/player/play', { query: { device_id: deviceId }, body });
    }

    pause(deviceId) {
        return this.request('PUT', '/me/player/pause', { query: { device_id: deviceId } });
    }

    skip(direction, deviceId) {
        return this.request('POST', `/me/player/${direction}`, { query: { device_id: deviceId } });
    }

    setShuffle(on, deviceId) {
        return this.request('PUT', '/me/player/shuffle', { query: { state: Boolean(on), device_id: deviceId } });
    }

    setRepeat(state, deviceId) {
        return this.request('PUT', '/me/player/repeat', { query: { state, device_id: deviceId } });
    }

    // --- tokens ------------------------------------------------------------------

    _requireClient() {
        if (!this.clientId) throw new SpotifyError('no-client-id');
    }

    async _accessToken() {
        this._requireClient();
        if (!this.refreshToken) throw new SpotifyError('not-connected');
        if (this._access && this._now() < this._expires - EXPIRY_MARGIN_MS) return this._access;
        this._refreshing ||= this._refresh().finally(() => { this._refreshing = null; });
        return this._refreshing;
    }

    async _refresh() {
        const body = await this._token({
            grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: this.clientId,
        });
        if (body.refresh_token && body.refresh_token !== this.refreshToken) {
            this.refreshToken = body.refresh_token;
            this._onRefreshToken(body.refresh_token);
        }
        return this._access;
    }

    async _token(form) {
        const response = await this._send(new URL('/api/token', this._accounts), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams(form).toString(),
        });
        const text = await response.text();
        let body = {};
        try { body = text ? JSON.parse(text) : {}; } catch { /* reported below */ }

        if (!response.ok) {
            // A revoked or expired refresh token cannot recover; the user has to sign in again.
            if (body.error === 'invalid_grant' && form.grant_type === 'refresh_token') {
                this.forget();
                this._onRevoked();
                throw new SpotifyError('reconnect');
            }
            if (response.status === 429) {
                throw new SpotifyError('rate-limited', 'Spotify is rate limiting sign-in; try again shortly.');
            }
            const reason = body.error_description || body.error || `HTTP ${response.status}`;
            throw new SpotifyError('login', `Spotify refused the sign-in: ${this.clean(reason)}`);
        }
        if (!body.access_token) throw new SpotifyError('login', 'Spotify sent no access token.');
        this._access = body.access_token;
        this._expires = this._now() + (Number(body.expires_in) || 3600) * 1000;
        return body;
    }

    async _send(url, init) {
        try {
            return await this._fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        } catch (err) {
            const reason = this.clean(err.cause?.code || err.message);
            throw new SpotifyError('network', `Could not reach Spotify (${reason}).`);
        }
    }

    // --- errors ------------------------------------------------------------------

    async _failure(response) {
        let error = {};
        try { error = (await response.json()).error || {}; } catch { /* no JSON body */ }
        const message = this.clean(typeof error === 'string' ? error : error.message);
        const reason = String(error.reason || '').toUpperCase();
        const text = `${message} ${reason}`.toLowerCase();
        const extra = { status: response.status };

        if (response.status === 401) return new SpotifyError('reconnect', '', extra);
        if (response.status === 403) {
            if (reason === 'PREMIUM_REQUIRED' || text.includes('premium')) return new SpotifyError('premium', '', extra);
            if (/not registered|developer dashboard|user management|allowlist/.test(text)) {
                return new SpotifyError('not-allowlisted', '', extra);
            }
            if (text.includes('scope')) return new SpotifyError('reconnect', '', extra);
            // Pausing what is already paused is refused this way; callers that only want the state ignore it.
            if (text.includes('restriction violated')) {
                return new SpotifyError('restricted', 'Spotify cannot do that right now.', extra);
            }
            return new SpotifyError('forbidden', `Spotify refused the request${message ? `: ${message}` : ''}.`, extra);
        }
        if (response.status === 404) {
            if (reason === 'NO_ACTIVE_DEVICE' || text.includes('device')) return new SpotifyError('no-device', '', extra);
            return new SpotifyError('not-found', 'Spotify could not find that.', extra);
        }
        return new SpotifyError('api', `Spotify: ${message || 'request failed'} (HTTP ${response.status}).`, extra);
    }
}

module.exports = { SpotifyApi, SpotifyError, SCOPES, CALLBACK_PATH, pkcePair, authorizeUrl, redirectUriFor };
